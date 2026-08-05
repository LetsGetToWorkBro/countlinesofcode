/** Types for the plain-JS vendoring script, so tests can import its manifest. */
export interface VendorSpec {
  from: string;
  to: string;
}

export declare const VENDORED: VendorSpec[];
export declare const VENDORED_DIRS: VendorSpec[];
export declare function dirSource(spec: VendorSpec): string;
export declare function dirTarget(spec: VendorSpec): string;
export declare function sourcePath(spec: VendorSpec): string;
export declare function vendoredPath(spec: VendorSpec): string;
export declare function pdfjsVersion(): string;
