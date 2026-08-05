/** Types for the plain-JS build script, so tests can import its options. */
import type { BuildOptions, BuildResult } from 'esbuild';

export interface BundleSpec {
  entry: string;
  outfile: string;
  banner: string;
}

export declare const BUNDLES: BundleSpec[];
export declare const BUILD_OPTIONS: BuildOptions;
export declare function optionsFor(spec: BundleSpec): BuildOptions;
export declare function bundle(outfile?: string, spec?: BundleSpec): Promise<BuildResult>;
