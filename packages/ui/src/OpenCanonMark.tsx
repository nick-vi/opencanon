import { useId } from "react";

export function OpenCanonMark({
  className,
  decorative = true,
  size = 24,
  title = "OpenCanon mark",
}: {
  className?: string;
  decorative?: boolean;
  size?: number;
  title?: string;
}) {
  const titleId = useId();
  return (
    <svg
      className={className ? `openCanonMark ${className}` : "openCanonMark"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={decorative ? "true" : undefined}
      role={decorative ? undefined : "img"}
      aria-labelledby={decorative ? undefined : titleId}
    >
      {decorative ? null : <title id={titleId}>{title}</title>}
      <rect className="openCanonMarkShell" x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path className="openCanonMarkRule" d="M7 8.25h10" />
      <path className="openCanonMarkRule openCanonMarkAccent" d="M7 12h6.4" />
      <path className="openCanonMarkJoin openCanonMarkAccent" d="M13.4 12h2.1" />
      <circle className="openCanonMarkNode openCanonMarkAccent" cx="17" cy="12" r="1.45" />
      <path className="openCanonMarkRule openCanonMarkShort" d="M7 15.75h4.7" />
    </svg>
  );
}
