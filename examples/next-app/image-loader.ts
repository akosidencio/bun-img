// next/image requires `loaderFile` to name a file with a default export, and it
// bundles that file for the browser. Re-exporting keeps ours client-safe.
export { default } from "bun-img/next/loader";
