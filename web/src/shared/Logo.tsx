/** Credoc mark: a shipping document with its folded corner and two lines of text cut out. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M 0 0 L 168 0 L 168 88 L 256 88 L 256 256 L 0 256 Z M 48 140 L 208 140 L 208 164 L 48 164 Z M 48 192 L 152 192 L 152 216 L 48 216 Z"
      />
      <path d="M 192 0 L 256 64 L 192 64 Z" />
    </svg>
  );
}
