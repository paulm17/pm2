import { build } from 'rolldown'

// Get CLI arguments
const args = process.argv.slice(2)
const outputType = args.includes('--type') && args[args.indexOf('--type') + 1] || 'esm'

// Build and write to disk immediately
await build({
  input: 'src/index.ts',
  platform: "node",
  output: {
    file: outputType === 'esm' ? 'dist/index.esm.js' : 'dist/index.cjs',
    format: outputType === 'esm' ? 'esm' : 'cjs',
    banner: outputType === 'esm' ? 
      `import path from 'path';
      import { fileURLToPath } from 'url';
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);` :
      '',    
  },
})
