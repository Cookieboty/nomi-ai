/** Vite `?url` asset imports (the renderer does not pull in vite/client types globally). */
declare module '*?url' {
  const url: string;
  export default url;
}
