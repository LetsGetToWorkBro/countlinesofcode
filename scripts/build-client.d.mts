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

/** The Monero wallet library bundle, built with browser shims and eval probes
 *  removed. Kept apart from BUNDLES because of that extra handling. */
export declare const MONERO_LIB: BundleSpec;
export declare const MONERO_ALIAS: Record<string, string>;
export declare function moneroLibOptions(): BuildOptions;
export declare function buildMoneroLib(): Promise<string>;
