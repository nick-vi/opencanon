import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type ElementProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
};

export function PaneHeader({ className, children, ...props }: ElementProps) {
  return (
    <div className={cx("paneHeader", className)} {...props}>
      {children}
    </div>
  );
}

export function PaneTitle({ className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return (
    <span className={cx("paneTitle", className)} {...props}>
      {children}
    </span>
  );
}

export function PaneSubtitle({ className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return (
    <span className={cx("paneSubtitle", className)} {...props}>
      {children}
    </span>
  );
}

export function PaneBody({ className, scroll = false, children, ...props }: ElementProps & { scroll?: boolean }) {
  return (
    <div className={cx("paneBody", scroll && "scroll", className)} {...props}>
      {children}
    </div>
  );
}

export function InlineState({
  tone = "muted",
  padded = true,
  className,
  children,
}: HTMLAttributes<HTMLDivElement> & {
  tone?: "muted" | "error";
  padded?: boolean;
  children: ReactNode;
}) {
  return <div className={cx(tone === "error" ? "severityError" : "muted", padded && "padded", className)}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: HTMLAttributes<HTMLDivElement> & {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("emptyState", className)}>
      {icon}
      <div className="emptyStateTitle">{title}</div>
      <div>{children}</div>
    </div>
  );
}

export function IconButton({
  active = false,
  square = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  square?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className={cx("iconButton", active && "active", square && "iconButtonSquare", className)} {...props}>
      {children}
    </button>
  );
}

export function PaneButton({
  inline = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className={cx("paneButton", inline && "paneButtonInline", className)} {...props}>
      {children}
    </button>
  );
}

export function SegmentedControl({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("segmentedControl", className)} aria-label={label}>
      {children}
    </div>
  );
}

export function SegmentedButton({
  active = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className={cx("segmentedButton", active && "active", className)} aria-pressed={active} {...props}>
      {children}
    </button>
  );
}

export function StatusTag({ status, label = status, className }: { status: string; label?: string; className?: string }) {
  return <span className={cx("statusTag", `status-${status}`, className)}>{label}</span>;
}

export function SeverityTag({ severity, className }: { severity: "error" | "warning" | "info"; className?: string }) {
  return <span className={cx("severityTag", `severity-${severity}`, className)}>{severity}</span>;
}
