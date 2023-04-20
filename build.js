#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';

import copy from 'esbuild-plugin-copy';

import { cleanPlugin } from './pkg/lib/esbuild-cleanup-plugin.js';
import { cockpitCompressPlugin } from './pkg/lib/esbuild-compress-plugin.js';
import { cockpitPoEsbuildPlugin } from './pkg/lib/cockpit-po-plugin.js';
import { cockpitRsyncEsbuildPlugin } from './pkg/lib/cockpit-rsync-plugin.js';
import { esbuildStylesPlugins } from './pkg/lib/esbuild-common.js';
import { eslintPlugin } from './pkg/lib/esbuild-eslint-plugin.js';

const useWasm = os.arch() !== 'x64';
const esbuild = (await import(useWasm ? 'esbuild-wasm' : 'esbuild')).default;

const production = process.env.NODE_ENV === 'production';
const watchMode = process.env.ESBUILD_WATCH === "true";
// linters dominate the build time, so disable them for production builds by default, but enable in watch mode
const lint = process.env.LINT ? (process.env.LINT !== 0) : (watchMode || !production);
// List of directories to use when using import statements
const nodePaths = ['pkg/lib'];
const outdir = 'dist';

// Obtain package name from package.json
const packageJson = JSON.parse(fs.readFileSync('package.json'));

function notifyEndPlugin() {
    return {
        name: 'notify-end',
        setup(build) {
            let startTime;

            build.onStart(() => {
                startTime = new Date();
            });

            build.onEnd(() => {
                const endTime = new Date();
                const timeStamp = endTime.toTimeString().split(' ')[0];
                console.log(`${timeStamp}: Build finished in ${endTime - startTime} ms`);
            });
        }
    };
}

const cwd = process.cwd();

const context = await esbuild.context({
    ...!production ? { sourcemap: "linked" } : {},
    bundle: true,
    entryPoints: ['./src/index.js'],
    external: ['*.woff', '*.woff2', '*.jpg', '*.svg', '../../assets*'], // Allow external font files which live in ../../static/fonts
    legalComments: 'external', // Move all legal comments to a .LEGAL.txt file
    loader: { ".js": "jsx" },
    minify: production,
    nodePaths,
    outdir,
    target: ['es2020'],
    plugins: [
        cleanPlugin(),
        ...lint
            ? [
                eslintPlugin({ filter: new RegExp(cwd + '/src/.*\\.(jsx?|js?)$') })
            ]
            : [],
        // Esbuild will only copy assets that are explicitly imported and used
        // in the code. This is a problem for index.html and manifest.json which are not imported
        copy({
            assets: [
                { from: ['./src/manifest.json'], to: ['./manifest.json'] },
                { from: ['./src/index.html'], to: ['./index.html'] },
            ]
        }),
        ...esbuildStylesPlugins,
        cockpitPoEsbuildPlugin(),
        ...production ? [cockpitCompressPlugin()] : [],
        cockpitRsyncEsbuildPlugin({ dest: packageJson.name }),
        notifyEndPlugin(),
    ]
});

try {
    await context.rebuild();
} catch (e) {
    if (!watchMode)
        process.exit(1);
    // ignore errors in watch mode
}

if (watchMode) {
    // Attention: this does not watch subdirectories -- if you ever introduce one, need to set up one watch per subdir
    fs.watch('src', {}, async (ev, path) => {
        // only listen for "change" events, as renames are noisy
        if (ev !== "change")
            return;

        console.log("change detected:", path);
        await context.cancel();

        try {
            await context.rebuild();
        } catch (e) {
            // ignore in watch mode
        }
    });

    // wait forever until Control-C
    await new Promise(() => {});
}

context.dispose();