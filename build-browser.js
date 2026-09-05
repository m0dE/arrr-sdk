import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes('--watch');

// Shared build options
const commonOptions = {
    bundle: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    mainFields: ['browser', 'module', 'main'],
};

// Build configurations
const builds = [
    // IIFE build for script tag usage (network/examples/)
    {
        entryPoints: [join(__dirname, 'src/arrr-network.ts')],
        outfile: join(__dirname, 'dist/arrr-network.iife.js'),
        format: 'iife',
        globalName: 'arrrNetwork',
        ...commonOptions,
    },
    // ESM build for module usage
    {
        entryPoints: [join(__dirname, 'src/arrr-network.ts')],
        outfile: join(__dirname, 'dist/arrr-network.esm.js'),
        format: 'esm',
        ...commonOptions,
    },
    // Minified IIFE for production
    {
        entryPoints: [join(__dirname, 'src/arrr-network.ts')],
        outfile: join(__dirname, 'dist/arrr-network.min.js'),
        format: 'iife',
        globalName: 'arrrNetwork',
        minify: true,
        ...commonOptions,
    },
    // Also build to homepage/public/sdk for the docs site.
    // __dirname is <repo>/sdk, so this is ONE level up, not two. It was
    // '../../homepage/...', which resolves outside the repository entirely -
    // the build silently wrote to a sibling directory and the bundle checked in
    // at homepage/public/sdk was never actually updated by `npm run
    // build:browser`. That is why the committed browser bundle drifted several
    // protocol revisions behind the server.
    {
        entryPoints: [join(__dirname, 'src/arrr-network.ts')],
        outfile: join(__dirname, '../homepage/public/sdk/arrr-network.iife.js'),
        format: 'iife',
        globalName: 'arrrNetwork',
        ...commonOptions,
    },
];

async function build() {
    console.log('Building ARRR Network SDK for Browser...\n');

    for (const config of builds) {
        try {
            if (isWatch) {
                const ctx = await esbuild.context(config);
                await ctx.watch();
                console.log(`Watching: ${config.entryPoints[0]} -> ${config.outfile}`);
            } else {
                await esbuild.build(config);
                console.log(`Built: ${config.outfile}`);
            }
        } catch (err) {
            console.error(`Failed to build ${config.outfile}:`, err);
            process.exit(1);
        }
    }

    if (!isWatch) {
        console.log('\nBuild complete!');
    } else {
        console.log('\nWatching for changes...');
    }
}

build();
