/** Types for the plain-JS vendoring script, so tests can import its manifest. */
export interface VendorSpec {
  from: string;
  to: string;
}

/** A library copied wholesale from a named package. */
export interface LibSpec {
  pkg: string;
  from: string;
  to: string;
}

export declare const VENDORED: VendorSpec[];
export declare const VENDORED_DIRS: VendorSpec[];
export declare const VENDORED_LIBS: LibSpec[];
export declare function dirSource(spec: VendorSpec): string;
export declare function dirTarget(spec: VendorSpec): string;
export declare function sourcePath(spec: VendorSpec): string;
export declare function vendoredPath(spec: VendorSpec): string;
export declare function libSource(spec: LibSpec): string;
export declare function libTarget(spec: LibSpec): string;
export declare function pdfjsVersion(): string;
export declare function libheifVersion(): string;
