import { useEffect, useState } from "react";

/**
 * An audio or video file in the browser's own player. A file link opens once, so the player can't make range
 * requests to it; the bytes, already fetched (uploads are at most 25 MB), play from memory instead, where seeking
 * is free. The browser plays only what it can decode, and a media file runs nothing.
 */
export function MediaPlayer(props: {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly label: string;
}) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // The type rides on the blob, so the player never sniffs one from the bytes.
    const url = URL.createObjectURL(new Blob([props.bytes.slice()], { type: props.mime }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [props.bytes, props.mime]);
  if (failed) return <p role="alert">This browser can't play this file. Download it to play it elsewhere.</p>;
  if (!src) return null;
  return props.mime.startsWith("video/") ? (
    <video
      className="media"
      src={src}
      controls
      preload="metadata"
      aria-label={props.label}
      onError={() => setFailed(true)}
    />
  ) : (
    <audio
      className="media"
      src={src}
      controls
      preload="metadata"
      aria-label={props.label}
      onError={() => setFailed(true)}
    />
  );
}
