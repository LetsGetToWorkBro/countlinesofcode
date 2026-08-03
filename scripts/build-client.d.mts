/** Types for the plain-JS build script, so tests can import BUILD_OPTIONS. */
import type { BuildOptions } from 'esbuild';

export declare const BUILD_OPTIONS: BuildOptions;
export declare function bundle(outfile?: string): Promise<import('esbuild').BuildResult>;
