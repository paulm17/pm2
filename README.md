# Enhanced ProcessManager for Electron

A robust process management tool forked from [theproductiveprogrammer/pm2](https://github.com/theproductiveprogrammer/pm2). This project addresses known issues in [pm2](https://github.com/Unitech/pm2) when running process management inside Electron, making it more reliable, secure, and efficient.

---

## Overview

The **Enhanced ProcessManager for Electron** allows you to start, monitor, and manage multiple processes (both NodeJS and binary executables) with features such as:

- **Automatic Restarting:** Recovers from process crashes using configurable back-off intervals.
- **Graceful Shutdown:** Integrates with Electron’s lifecycle to ensure clean termination.
- **Resource Monitoring:** Continuously checks memory (and potentially CPU) usage to prevent runaway processes.
- **Logging:** Captures and logs process output, with automatic log rotation.

---

## Key Enhancements for Electron

This fork introduces several improvements specifically designed for Electron environments:

- **ASAR Safety:**  
  Uses Electron’s `app.getAppPath()` to properly resolve paths inside ASAR archives, avoiding manual path manipulation issues.

- **Process Isolation:**  
  Configures child processes to run in isolation from Electron’s runtime (e.g., by setting `ELECTRON_RUN_AS_NODE` and filtering certain exec arguments) to prevent unwanted inheritance of Electron-specific characteristics.

- **Resource Management:**  
  Implements shutdown hooks and integrates with Electron’s lifecycle events to ensure that all child processes are correctly terminated during application shutdown.

- **Native Modules Handling:**  
  Provides support for compiling native dependencies (e.g., `pidusage`) with tools like `electron-rebuild`, ensuring compatibility with Electron’s embedded NodeJS.

- **Cross-Platform Support:**  
  Leverages reliable process spawning techniques (and can work with tools like cross-spawn) to deliver consistent behavior across different operating systems.

- **Security Improvements:**  
  Validates IPC messages and sanitizes inputs sent to child processes to bolster the security of inter-process communications.

- **Performance Monitoring:**  
  Monitors memory usage at regular intervals and initiates graceful restarts if thresholds are exceeded, helping maintain optimal performance.

---

## Features

- **Multiple Process Types:**  
  Supports starting both NodeJS scripts and binary executables, including direct handling of Node modules.

- **Configurable Process Options:**  
  Customize arguments, working directories, environment variables, and I/O settings for each process.

- **Robust Error Handling:**  
  Automatically restarts processes with an incremental delay strategy if they crash or exceed memory limits.

- **Integrated Logging:**  
  Captures standard output and error streams with options to strip ANSI escape codes for cleaner log files.

- **Electron Lifecycle Integration:**  
  Automatically stops all processes when Electron quits, preventing orphan processes.

---

## Installation

*(Installation instructions go here. For example, if published on npm, you might run:)*

```bash
npm install @tpp/pm2
```

## Usage

### Basic Example

```
import pm from '@tpp/pm2';

pm.start({
  script: 'path/to/your/script.js',
  name: 'my-process',
  cwd: '/path/to/your/app',
  log: 'process.log',
  stripANSI: true,
});
```

### Error Handling

Provide a callback to receive error notifications or process information:

```
pm.start({
  script: 'path/to/your/script.js',
  name: 'my-process',
}, (err, procInfo) => {
  if (err) {
    console.error('Error starting process:', err);
  } else {
    console.log('Process started with PID:', procInfo.child.pid);
  }
});
```

### Managing Processes

-   **Stopping a Process:**
        
```
pm.stop('my-process', (err) => {
  if (err) console.error('Error stopping process:', err);
});
``` 
    
-   **Stopping All Processes:**
        
```
pm.stopAll();
``` 
    
-   **Restarting a Process:**
    
  ```
  pm.restart('my-process');
 ```

### Advanced Configuration

Configure additional options like memory thresholds, custom restart intervals, and environment variables:

```
pm.start({
  script: 'path/to/your/script.js',
  name: 'advanced-process',
  memoryThreshold: 50 * 1024 * 1024, // 50MB
  restartIntervals: [100, 500, 1000, 30000, 60000, 300000, 900000],
  restartOk: 30 * 60 * 1000,
  env: { NODE_ENV: 'production' },
});
```

### Integrating with Electron

The ProcessManager is optimized for Electron. It automatically integrates with Electron’s shutdown events to clean up child processes:

```
// In your Electron main process:
import pm from '@tpp/pm2';
const { app } = require('electron');

app.on('before-quit', () => {
  pm.stopAll();
});
```

## API Overview

### ProcessManager Methods

-   **start(options, callback):**  
    Launch a new process using the specified options.  
    _Options include:_
    
    -   `script`: Path to the script or executable.
    -   `args`: Array of command-line arguments.
    -   `cwd`: Working directory.
    -   `log`: Log file path.
    -   `stripANSI`: Boolean to enable stripping of ANSI escape codes.
    -   `restartIntervals`: Array defining delays between restarts.
    -   `restartOk`: Time period after which a restart is considered successful.
    -   `env`: Environment variables.
    -   `stdio`: Standard I/O configuration.
    -   `memoryThreshold`: Maximum allowed memory usage (in bytes) before triggering a restart.
    -   `debug`: Enable/disable debug logging.
-   **stopByName(name):**  
    Gracefully stops a process identified by its name.
    
-   **stopAll():**  
    Gracefully stops all managed processes.
    
-   **restartByName(name):**  
    Restarts a process identified by its name.
    
-   **setOnStopping(hook):**  
    Sets a hook function to be executed when the process manager initiates shutdown.

## License
MIT