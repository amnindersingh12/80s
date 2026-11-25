import { useState } from "react";
import { hueFor, initials } from "../lib/format";

/** Album art with a generated gradient placeholder when there is no image (or it fails to load). */
export function Cover({ src, title, size = 48, className = "" }: { src?: string; title: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const hue = hueFor(title);
  if (!src || failed) {
    return (
      <div
        className={`cover cover-ph ${className}`}
        style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 50) % 360} 60% 22%))` }}
        aria-hidden="true"
      >
        <span style={{ fontSize: Math.max(11, size / 3) }}>{initials(title)}</span>
      </div>
    );
  }
  return (
    <img
      className={`cover ${className}`}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
