import { useState } from 'react';

/**
 * Ministry crest. Uses /ministry-logo.png (drop the file in public/); falls back
 * to a text monogram if the image isn't present yet, so nothing breaks.
 */
export function Crest({ size = 40 }: { size?: number }) {
  const [ok, setOk] = useState(true);
  if (ok) {
    return (
      <img
        src="/ministry-logo.png"
        alt="Ministry of Energy and Green Transition"
        onError={() => setOk(false)}
        style={{ width: size, height: size }}
        className="rounded-full object-contain bg-white"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-full bg-white text-ministry-dark flex items-center justify-center font-bold text-xs"
    >
      MoEGT
    </div>
  );
}
