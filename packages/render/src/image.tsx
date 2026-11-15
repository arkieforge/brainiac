import { useState } from "react";

/**
 * An image file, fitted to the pane; a tap shows it at full size. The browser decodes it from the usercontent
 * origin, where it can't run anything even if it is really something else (nosniff, sandbox CSP).
 */
export function ImageViewer({ src, alt }: { readonly src: string; readonly alt: string }) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <p role="alert">This image could not load.</p>;
  return (
    <button type="button" className="image" data-full={full} onClick={() => setFull(!full)}>
      <img src={src} alt={alt} onError={() => setFailed(true)} referrerPolicy="no-referrer" />
    </button>
  );
}

/**
 * An HTML or SVG file, which may hold scripts: in a frame on the usercontent origin with every sandbox flag off,
 * so it runs nothing and can't reach the site, whatever its CSP says.
 */
export function SandboxedFrame({ src, title }: { readonly src: string; readonly title: string }) {
  return <iframe className="sandboxed" src={src} title={title} sandbox="" referrerPolicy="no-referrer" />;
}
