'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { fork, spawn, ChildProcess } from 'child_process';
import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'events';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

interface ProcessMessage {
  stopping?: boolean;
}

interface ProcessOptions {
  name?: string;
  script?: string;
  args?: string[];
  cwd?: string;
  log?: string; // directory of the log files
  stripANSI?: boolean;
  restartIntervals?: number[];
  restartOk?: number;
  env?: NodeJS.ProcessEnv;
  stdio?: 'pipe' | 'inherit' | 'ignore';
  memoryThreshold?: number; // in bytes
  debug?: boolean;
}

type Callback<T = any> = (err: any, result?: T) => void;

class ProcessInfo extends EventEmitter {
  name?: string;
  script?: string;
  args: string[];
  cwd: string;
  log?: string;
  stripANSI?: boolean;
  restartIntervals: number[];
  restartOk: number;
  env: NodeJS.ProcessEnv;
  stdio: any;
  memoryThreshold?: number;
  debug?: boolean;

  lastStart: number;
  restartIndex: number;
  stopRequested: boolean;
  memoryMonitor: NodeJS.Timeout | null;
  child: ChildProcess | null;
  flush: (() => void) | null;

  constructor(options: ProcessOptions) {
    super();
    this.name = options.name;
    this.script = options.script;
    this.args = options.args || [];
    this.cwd = options.cwd || process.cwd();
    this.log = options.log;
    this.stripANSI = options.stripANSI;
    this.restartIntervals = options.restartIntervals || [100, 500, 1000, 30000, 60000, 300000, 900000];
    this.restartOk = options.restartOk || 30 * 60 * 1000;
    this.env = options.env || process.env;
    this.stdio = options.stdio;
    this.memoryThreshold = options.memoryThreshold;
    this.debug = options.debug !== undefined ? options.debug : true;

    this.lastStart = Date.now();
    this.restartIndex = 0;
    this.stopRequested = false;
    this.memoryMonitor = null;
    this.child = null;
    this.flush = null;
  }
}

class ProcessManager {
  registry: Map<string, ProcessInfo>;
  onStoppingHook: (() => void) | null;
  onStoppingCalled: boolean;
  defaultRestartIntervals: number[];
  defaultRestartOk: number;

  constructor() {
    this.registry = new Map();
    this.onStoppingHook = null;
    this.onStoppingCalled = false;
    this.defaultRestartIntervals = [100, 500, 1000, 30000, 60000, 300000, 900000];
    this.defaultRestartOk = 30 * 60 * 1000;
    this._setupShutdownHooks();
    this._integrateElectronLifecycle();
  }

  private _setupShutdownHooks(): void {
    const callOnStoppingHook = (): void => {
      if (this.onStoppingCalled || !this.onStoppingHook) return;
      this.onStoppingCalled = true;
      this.onStoppingHook();
    };
    process.on('message', (m: ProcessMessage) => { if (m.stopping) callOnStoppingHook(); });
    process.on('beforeExit', callOnStoppingHook);
    process.on('exit', callOnStoppingHook);
  }

  private _integrateElectronLifecycle(): void {
    let electron;
    try {
      electron = require('electron');
    } catch (e) {
      electron = null;
    }
    const app = electron?.app;
    if (app) {
      app.on('before-quit', () => this.stopAll());
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') this.stopAll();
      });
    }
  }

  setOnStopping(hook: () => void): void {
    this.onStoppingHook = hook;
    this.onStoppingCalled = false;
  }

  forEach(callback: (pi: ProcessInfo, key: string) => void): void {
    this.registry.forEach(callback);
  }

  start(piOptions: ProcessOptions, cb: Callback<ProcessInfo> = (err, procInfo) => { if (err) console.error(err); }): void {
    if (!piOptions) {
      cb(new Error("No process info provided"));
      return;
    }
    if (!piOptions.script && !piOptions.cwd) {
      cb(new Error("Missing 'script' or 'cwd'"));
      return;
    }

    const options: ProcessOptions = {
      name: piOptions.name,
      script: piOptions.script,
      args: piOptions.args || [],
      cwd: piOptions.cwd || process.cwd(),
      log: piOptions.log,
      stripANSI: piOptions.stripANSI,
      restartIntervals: piOptions.restartIntervals || this.defaultRestartIntervals,
      restartOk: piOptions.restartOk || this.defaultRestartOk,
      env: piOptions.env || process.env,
      stdio: piOptions.stdio,
      memoryThreshold: piOptions.memoryThreshold,
      debug: piOptions.debug,
    };

    const resolveScript = (cbScript: Callback<string>) => {
      if (options.script) {
        cbScript(null, options.script);
        return;
      }
      const pkgPath = path.join(options.cwd as string, 'package.json');
      fs.readFile(pkgPath, (err, data) => {
        if (err) return cbScript(new Error("Cannot read package.json"));
        try {
          const pkg = JSON.parse(data.toString());
          if (!pkg.main) throw new Error("No main entry in package.json");
          cbScript(null, pkg.main);
        } catch (e) {
          cbScript(e);
        }
      });
    };

    resolveScript((err, script) => {
      if (err) {
        cb(err);
        return;
      }
      options.script = script;
      this._fixAsarIssue(options);
      const procInfo = new ProcessInfo(options);
      // Ensure key is a string
      const key: string = options.name || script!;
      this.registry.set(key, procInfo);
      const handler = this._getScriptHandler(script!);
      if (!handler) {
        cb(new Error(`No handler for script ${script}`));
        return;
      }
      handler.call(this, procInfo);

      if (options.memoryThreshold) {
        this._startMemoryMonitor(procInfo);
      }
      cb(null, procInfo);
    });
  }

  private _fixAsarIssue(pi: ProcessOptions): void {
    let electron;
    try {
        electron = require('electron');
    } catch (e) {
        electron = null;
    }

    const appPath = electron?.app?.getAppPath() || process.cwd();

    if (appPath.includes('.asar')) {
      pi.cwd = (pi.cwd || process.cwd()).replace(/\.asar([\\/]).*/, '.asar$1');

      if (pi.script) {
        pi.script = path.relative(pi.cwd, path.resolve(appPath, pi.script));
      }
    }
  }

  private _getScriptHandler(script: string): ((pi: ProcessInfo) => void) | undefined {
    const ext = path.extname(script).toLowerCase();
    const handlers: Record<string, (pi: ProcessInfo) => void> = {
      '.js': this._launchJSProcess.bind(this),
    };

    if (handlers[ext]) {
      return handlers[ext];
    } else if (ext === '') {
      // Default handler for executables with no extension
      return this._launchBinaryProcess.bind(this);
    }
    return undefined;
  }

  private _launchBinaryProcess(pi: ProcessInfo): void {
    const opts = { cwd: pi.cwd, env: pi.env, windowsHide: false, detached: false };
    pi.child = spawn(pi.script as string, pi.args, opts);
    pi.flush = this._captureOutput(pi);
    this._handleExit(pi);
  }

  private _launchJSProcess(pi: ProcessInfo): void {
    try {
      const env = {
        ...pi.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: process.env.NODE_ENV
      };
      const opts = {
        silent: true,
        detached: false,
        cwd: pi.cwd,
        env,
        stdio: pi.stdio,
        execArgv: process.execArgv.filter(arg => !arg.startsWith('--remote-debugging-port'))
      };
      pi.child = fork(pi.script as string, pi.args, opts);
      pi.flush = this._captureOutput(pi);
      this._handleExit(pi);
    } catch (err: any) {
      pi.emit('error', new Error(`Failed to launch JS process: ${err.message}`));
      this._restartIfNeeded(pi);
    }
  }

  private _captureOutput(pi: ProcessInfo): () => void {
    if (!pi.child) return () => {};
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const processData = (data: Buffer, isError: boolean) => {
      let str = data.toString();
      if (pi.stripANSI) str = stripAnsi(str);
      const lines = (isError ? stderrBuffer : stdoutBuffer) + str;
      const split = lines.split(/[\n\r]+/);
      const completeLines = split.slice(0, -1);
      if (isError) {
        completeLines.forEach(line => this._log(pi, line, true));
        stderrBuffer = split[split.length - 1];
      } else {
        completeLines.forEach(line => this._log(pi, line, false));
        stdoutBuffer = split[split.length - 1];
      }
    };

    if (pi.child.stdout)
      pi.child.stdout.on('data', (data: Buffer) => processData(data, false));
    if (pi.child.stderr)
      pi.child.stderr.on('data', (data: Buffer) => processData(data, true));

    return () => {
      if (stdoutBuffer.trim()) this._log(pi, stdoutBuffer.trim(), false);
      if (stderrBuffer.trim()) this._log(pi, stderrBuffer.trim(), true);
      stdoutBuffer = '';
      stderrBuffer = '';
    };
  }

  private _log(pi: ProcessInfo, line: string, isError: boolean): void {
    const prefix = pi.name ? `${pi.name}: ` : '';
    const msg = prefix + line;
    const handleError = (err: NodeJS.ErrnoException | null) => { if (err) console.error('Log error:', err); };
    if (pi.log) {
      fs.stat(pi.log!, (err, stats) => {
        if (!err && stats.size > MAX_LOG_SIZE) {
          fs.rename(pi.log!, `${pi.log}.old`, () => {
            fs.appendFile(pi.log!, msg + '\n', handleError);
          });
        } else {
          fs.appendFile(pi.log!, msg + '\n', handleError);
        }
      });
    }
    if (pi.debug) {
      isError ? console.error(msg) : console.log(msg);
    }
  }

  private _handleExit(pi: ProcessInfo): void {
    if (!pi.child) return;
    let exitHandled = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitHandled) return;
      exitHandled = true;
      pi.flush && pi.flush();
      const statusMsg = code ? `Exited with code ${code}` : signal ? `Killed with signal ${signal}` : 'Process exited';
      pi.emit('exit', statusMsg, pi.child?.pid);
      if (pi.memoryMonitor) {
        clearInterval(pi.memoryMonitor);
        pi.memoryMonitor = null;
      }
      this._restartIfNeeded(pi);
    };
    pi.child.on('error', (err: Error) => {
      pi.flush && pi.flush();
      pi.emit('error', err);
      this._restartIfNeeded(pi);
    });
    pi.child.once('exit', onExit);
    pi.child.once('close', onExit);
  }

  private _restartIfNeeded(pi: ProcessInfo): void {
    if (pi.stopRequested || (pi.child && pi.child.exitCode === null)) return;
    const now = Date.now();
    if (now - pi.lastStart > pi.restartOk) {
      pi.restartIndex = 0;
    }
    const interval = pi.restartIntervals[Math.min(pi.restartIndex, pi.restartIntervals.length - 1)];
    pi.restartIndex++;
    setTimeout(() => {
      if (pi.stopRequested) return;
      this._startAgain(pi);
    }, interval);
  }

  private _startAgain(pi: ProcessInfo): void {
    const handler = this._getScriptHandler(pi.script as string);
    if (!handler) {
      pi.emit('error', new Error(`Cannot restart, unknown handler for ${pi.script}`));
      return;
    }
    pi.lastStart = Date.now();
    handler.call(this, pi);
    pi.stopRequested = false;
    pi.emit('restart');
    if (pi.memoryThreshold) {
      this._startMemoryMonitor(pi);
    }
  }

  private _startMemoryMonitor(pi: ProcessInfo): void {
    if (pi.memoryMonitor) clearInterval(pi.memoryMonitor);
    pi.memoryMonitor = setInterval(() => {
      this._getMemoryUsage(pi.child?.pid as number, (err, usage) => {
        if (err) {
          console.error("Memory usage check error:", err);
          return;
        }
        if (usage && pi.memoryThreshold && usage > pi.memoryThreshold) {
          console.log(`Process ${pi.name || pi.script} exceeded memory threshold (${usage} bytes > ${pi.memoryThreshold} bytes). Initiating graceful restart.`);
          this.gracefulStop(pi, () => this._startAgain(pi));
        }
      });
    }, 5000) as unknown as NodeJS.Timeout;
  }

  private _getMemoryUsage(pid: number, callback: (err: Error | null, usage?: number) => void): void {
    try {
      const pidusage = require('pidusage');
      pidusage(pid, (err: Error, stats: any) => {
        if (err) return callback(err);
        callback(null, stats.memory);
      });
    } catch (err) {
      callback(err as Error);
    }
  }

  gracefulStop(pi: ProcessInfo, cb: () => void = () => {}): void {
    pi.stopRequested = true;
    const child = pi.child;
    if (child && child.exitCode === null && child.pid) {
      try {
        const treeKill = require('tree-kill');
        if (child.send) {
          child.send({ stopping: true });
          const timeout = setTimeout(() => {
            console.log(`Force killing process ${pi.name || pi.script}`);
            treeKill(child.pid, 'SIGKILL', cb);
          }, 3000);
          child.once('exit', () => {
            clearTimeout(timeout);
            cb();
          });
        } else {
          treeKill(child.pid, 'SIGTERM', cb);
        }
      } catch (err) {
        pi.emit('error', err);
        cb();
      }
    } else {
      cb();
    }
  }

  stopByName(name: string): void {
    this.registry.forEach((pi, key) => {
      if (pi.name === name || key === name) {
        this.gracefulStop(pi);
      }
    });
  }

  stopAll(): void {
    this.registry.forEach(pi => this.gracefulStop(pi));
  }

  restartByName(name: string): void {
    this.registry.forEach((pi, key) => {
      if (pi.name === name || key === name) {
        this.gracefulStop(pi, () => this._startAgain(pi));
      }
    });
  }
}

export default new ProcessManager();
