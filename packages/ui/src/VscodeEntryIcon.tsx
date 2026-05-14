import { memo, useMemo } from "react";
import { resolveVscodeIconForEntry, type VscodeEntryKind as VscodeEntryKindValue } from "./vscodeIcons.ts";

const VscodeEntryIconClassName = {
  Root: "vscodeEntryIcon",
  Svg: "vscodeEntryIconSvg",
} as const;

const VscodeEntryIconViewBox = "0 0 32 32";

type Props = {
  pathValue: string;
  kind: VscodeEntryKindValue;
  expanded?: boolean;
  className?: string;
};

export const VscodeEntryIcon = memo(function VscodeEntryIcon({
  pathValue,
  kind,
  expanded = false,
  className,
}: Props) {
  const icon = useMemo(() => resolveVscodeIconForEntry(pathValue, kind, expanded), [expanded, kind, pathValue]);

  return (
    <span
      className={[VscodeEntryIconClassName.Root, className].filter(Boolean).join(" ")}
      data-vscode-icon={icon.filename}
      data-vscode-icon-kind={kind}
      aria-hidden="true"
    >
      <svg className={VscodeEntryIconClassName.Svg} focusable="false" viewBox={VscodeEntryIconViewBox}>
        <use href={icon.href} xlinkHref={icon.href} />
      </svg>
    </span>
  );
});
