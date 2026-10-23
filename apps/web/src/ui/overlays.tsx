// Overlays as native <dialog> elements (ADR 0039): showModal() gives the focus trap, Escape and
// focus return. Buttons open and close them with invoker commands (commandfor + command), which
// needs no script in current browsers; dialog.ts does the same where commands are missing.
import { Button, IconButton } from "./core.js";
import { cx, T, type Child } from "./shared.js";

export interface DialogProps {
  /** The trigger's commandfor; also the base of the title and description ids. */
  id: string;
  title: Child;
  description?: Child;
  /** sm 440 (confirm), md 560 (short form), lg 720 (editor). */
  size?: "sm" | "md" | "lg";
  actions?: Child;
  footerStart?: Child;
  /** Rendered open by the server (a confirm page without script); dialog.ts makes it modal. */
  open?: boolean | undefined;
  /** Show the X button in the header. */
  closable?: boolean;
  children?: Child;
}

export function Dialog({ id, title, description, size = "sm", actions, footerStart, open = false, closable = true, children }: DialogProps) {
  const titleId = `${id}-title`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <dialog id={id} class={cx("ia-dialog", `ia-dialog--${size}`)} aria-labelledby={titleId} aria-describedby={descId} open={open} data-modal="">
      <div class="ia-dialog__head">
        <div class="ia-dialog__titles">
          <h2 class={cx("ia-dialog__title", T.titleSm)} id={titleId}>
            {title}
          </h2>
          {description && (
            <p class={cx("ia-dialog__desc", T.body)} id={descId}>
              {description}
            </p>
          )}
        </div>
        {closable && <IconButton icon="x" label="Close" size="sm" commandfor={id} command="close" />}
      </div>
      {children && <div class="ia-dialog__body">{children}</div>}
      {actions && (
        <div class="ia-dialog__foot">
          <div class="ia-dialog__foot-start">{footerStart}</div>
          <div class="ia-dialog__actions">{actions}</div>
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  id: string;
  /** The question: "Archive this product?" */
  title: Child;
  description?: Child;
  /** Repeats the verb: "Archive product". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** Where the confirm button posts. */
  action: string;
  /** Hidden inputs for the post, the CSRF token among them. */
  fields?: Child;
  open?: boolean;
}

/** Cancel comes first and takes the focus; the confirm button posts the dialog's own form. */
export function ConfirmDialog({ id, title, description, confirmLabel, cancelLabel = "Cancel", tone = "danger", action, fields, open }: ConfirmDialogProps) {
  const formId = `${id}-form`;
  return (
    <Dialog
      id={id}
      size="sm"
      title={title}
      description={description}
      open={open}
      closable={false}
      footerStart={
        <form id={formId} method="post" action={action}>
          {fields}
        </form>
      }
      actions={[
        <Button commandfor={id} command="close" autofocus>
          {cancelLabel}
        </Button>,
        <Button variant={tone === "danger" ? "danger" : "primary"} type="submit" form={formId}>
          {confirmLabel}
        </Button>,
      ]}
    />
  );
}
