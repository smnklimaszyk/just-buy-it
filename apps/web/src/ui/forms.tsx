// Forms: Field, Fieldset, Input, Textarea, Select, RadioGroup, Checkbox, TagsInput, OtpInput.
// Same markup as the design system's forms.tsx. Every control posts with a plain form; the page
// scripts (tags.ts, otp.ts) only add comfort on top.
import type { RadioGroup as DsRadioGroup } from "../../design-system/components/index.js";
import { Icon } from "./core.js";
import type { IconName } from "./icon-names.js";
import { cx, T, type Child } from "./shared.js";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: "true";
  required?: boolean;
}

export interface FieldProps {
  /** Required here: there is no client-side useId, and the label needs it. */
  id: string;
  label?: Child;
  hint?: Child;
  /** Replaces the hint, in danger-fg with an icon. */
  error?: Child;
  required?: boolean;
  optional?: boolean | undefined;
  labelAction?: Child;
  className?: string | undefined;
  children: (control: FieldControlProps) => Child;
}

/** Label above, hint or error below, ids wired for assistive tech. */
export function Field({ label, hint, error, required, optional, id, children, className, labelAction }: FieldProps) {
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;
  const control: FieldControlProps = { id };
  if (describedBy) control["aria-describedby"] = describedBy;
  if (error) control["aria-invalid"] = "true";
  if (required) control.required = true;
  return (
    <div class={cx("ia-field", className)}>
      {label && (
        <div class="ia-field__top">
          <label class={cx("ia-field__label", T.label)} for={id}>
            {label}
            {optional && <span class="ia-field__opt"> (optional)</span>}
          </label>
          {labelAction}
        </div>
      )}
      {children(control)}
      {error ? (
        <p class={cx("ia-field__error", T.bodySm)} id={errId}>
          <Icon name="circle-alert" size={14} />
          {error}
        </p>
      ) : hint ? (
        <p class={cx("ia-field__hint", T.bodySm)} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface FieldsetProps {
  legend?: Child;
  description?: Child;
  className?: string;
  children?: Child;
}

export function Fieldset({ legend, description, children, className }: FieldsetProps) {
  return (
    <fieldset class={cx("ia-fieldset", className)}>
      {legend && <legend class={cx("ia-fieldset__legend", T.titleSm)}>{legend}</legend>}
      {description && <p class={cx("ia-fieldset__desc", T.bodySm)}>{description}</p>}
      <div class="ia-fieldset__body">{children}</div>
    </fieldset>
  );
}

/** The <input> attributes a server-rendered form uses. */
export interface InputAttributes {
  name?: string;
  value?: string;
  type?: "text" | "email" | "number" | "search" | "url" | "tel";
  placeholder?: string;
  autocomplete?: string;
  inputmode?: "text" | "numeric" | "decimal" | "email" | "search";
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  autofocus?: boolean;
  maxlength?: number;
  minlength?: number;
  pattern?: string;
  min?: string;
  max?: string;
  step?: string;
  "aria-label"?: string;
}

export interface InputProps extends InputAttributes {
  id: string;
  label?: Child;
  hint?: Child;
  error?: Child;
  optional?: boolean;
  iconStart?: IconName;
  trailing?: Child;
  size?: "md" | "lg";
  className?: string;
}

interface InputControlProps extends InputAttributes, Partial<FieldControlProps> {
  iconStart?: IconName | undefined;
  size: "md" | "lg";
  invalid?: boolean;
  trailing?: Child;
  className?: string | undefined;
}

function InputControl({ iconStart, size, invalid, trailing, className, ...rest }: InputControlProps) {
  return (
    <div class={cx("ia-input", `ia-input--${size}`, invalid && "is-invalid", iconStart && "has-icon", className)}>
      {iconStart && <Icon name={iconStart} size={16} className="ia-input__icon" />}
      <input class={size === "lg" ? T.bodyLg : T.body} {...rest} />
      {trailing && <span class="ia-input__trail">{trailing}</span>}
    </div>
  );
}

export function Input({ label, hint, error, id, iconStart, size = "md", trailing, className, optional, ...rest }: InputProps) {
  if (!label && !hint && !error) {
    return <InputControl id={id} iconStart={iconStart} size={size} trailing={trailing} className={className} {...rest} />;
  }
  return (
    <Field label={label} hint={hint} error={error} id={id} optional={optional} className={className}>
      {(p) => <InputControl {...p} {...rest} iconStart={iconStart} size={size} trailing={trailing} invalid={!!error} />}
    </Field>
  );
}

export interface TextareaProps {
  id: string;
  name?: string;
  label?: Child;
  hint?: Child;
  error?: Child;
  rows?: number;
  maxLength?: number;
  value?: string;
  placeholder?: string;
  required?: boolean;
  optional?: boolean;
}

export function Textarea({ label, hint, error, id, rows = 3, maxLength, value = "", optional, ...rest }: TextareaProps) {
  const counter = maxLength ? (
    <span class={cx("ia-textarea__count", T.caption)} aria-live="polite">
      {value.length} / {maxLength}
    </span>
  ) : null;
  return (
    <Field label={label} hint={hint} error={error} id={id} optional={optional} labelAction={counter}>
      {(p) => (
        <textarea rows={rows} maxlength={maxLength} class={cx("ia-textarea", T.body, error && "is-invalid")} {...p} {...rest}>
          {value}
        </textarea>
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

export interface SelectProps {
  id: string;
  name?: string;
  label?: Child;
  hint?: Child;
  error?: Child;
  options: (SelectOption | SelectGroup)[];
  placeholder?: string;
  value?: string;
  size?: "md" | "lg";
  optional?: boolean;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Select({ label, hint, error, id, options, placeholder, value, size = "md", optional, ...rest }: SelectProps) {
  const render = (o: SelectOption | SelectGroup) =>
    "options" in o ? (
      <optgroup label={o.label}>{o.options.map(render)}</optgroup>
    ) : (
      <option value={o.value} disabled={o.disabled} selected={o.value === value}>
        {o.label}
      </option>
    );
  const control = (p: Partial<FieldControlProps>) => (
    <div class={cx("ia-select", `ia-select--${size}`, error && "is-invalid")}>
      <select class={size === "lg" ? T.bodyLg : T.body} {...p} {...rest}>
        {placeholder && (
          <option value="" disabled selected={value === undefined || value === ""}>
            {placeholder}
          </option>
        )}
        {options.map(render)}
      </select>
      <Icon name="chevrons-up-down" size={14} className="ia-select__chev" />
    </div>
  );
  if (!label) return control({ id });
  return (
    <Field label={label} hint={hint} error={error} id={id} optional={optional}>
      {control}
    </Field>
  );
}

type DsRadioGroupProps = Parameters<typeof DsRadioGroup>[0];

export interface RadioOption {
  value: string;
  label: Child;
  description?: Child;
  disabled?: boolean;
}

export interface RadioGroupProps {
  /** Required here: the form field name, and what groups the radios. */
  name: string;
  legend?: Child;
  options: RadioOption[];
  value?: string;
  variant?: NonNullable<DsRadioGroupProps["variant"]>;
  orientation?: NonNullable<DsRadioGroupProps["orientation"]>;
}

/** `is-on` marks the checked option on first render; app.css follows :checked after a click. */
export function RadioGroup({ legend, name, options, value, variant = "list", orientation = "vertical" }: RadioGroupProps) {
  return (
    <fieldset class={cx("ia-radio-group", `ia-radio-group--${variant}`, orientation === "horizontal" && "is-row")}>
      {legend && <legend class={cx("ia-radio-group__legend", T.label)}>{legend}</legend>}
      {options.map((o) => (
        <label class={cx("ia-radio", o.value === value && "is-on", o.disabled && "is-disabled")}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={o.disabled} />
          <span class="ia-radio__dot" aria-hidden="true" />
          <span class="ia-radio__text">
            <span class={T.body}>{o.label}</span>
            {o.description && <span class={cx("ia-radio__desc", T.bodySm)}>{o.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export interface CheckboxProps {
  id: string;
  name?: string;
  value?: string;
  checked?: boolean;
  label?: Child;
  description?: Child;
  disabled?: boolean;
}

/**
 * The check glyph is always rendered and app.css shows it for :checked, so a click looks right
 * without script. The reference renders it only while checked.
 */
export function Checkbox({ checked = false, label, description, disabled, id, name, value }: CheckboxProps) {
  return (
    <label class={cx("ia-check", disabled && "is-disabled")} for={id}>
      <span class="ia-check__box-wrap">
        <input id={id} type="checkbox" name={name} value={value} checked={checked} disabled={disabled} />
        <span class={cx("ia-check__box", checked && "is-on")} aria-hidden="true">
          <Icon name="check" size={12} strokeWidth={2.5} />
        </span>
      </span>
      {(label || description) && (
        <span class="ia-check__text">
          {label && <span class={cx("ia-check__label", T.body)}>{label}</span>}
          {description && <span class={cx("ia-check__desc", T.bodySm)}>{description}</span>}
        </span>
      )}
    </label>
  );
}

export interface TagsInputProps {
  id: string;
  name?: string;
  label?: Child;
  hint?: Child;
  error?: Child;
  value?: string[];
  placeholder?: string;
  max?: number;
}

/**
 * Without script this is one text field with the words separated by commas, which is also what
 * the form posts. tags.ts shows the words as chips and keeps the field's value in step.
 */
export function TagsInput({ label, hint, error, id, name, value = [], placeholder = "Add and press Enter", max }: TagsInputProps) {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      {(p) => (
        <div class={cx("ia-tags", error && "is-invalid")}>
          <input {...p} class={T.body} name={name} value={value.join(", ")} placeholder={value.length ? "" : placeholder} data-tags="" data-max={max} />
        </div>
      )}
    </Field>
  );
}

export interface OtpInputProps {
  length?: number;
  value?: string;
  label?: string;
  /** Each cell posts one digit under this name; the server joins them in order. */
  name?: string;
  error?: Child;
  autofocus?: boolean;
}

export function OtpInput({ length = 6, value = "", label = "Verification code", name, error, autofocus }: OtpInputProps) {
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");
  return (
    <div class="ia-otp-wrap">
      <div class="ia-otp" role="group" aria-label={label}>
        {digits.map((d, i) => (
          <input
            class={cx("ia-otp__cell", T.title, error && "is-invalid")}
            name={name}
            inputmode="numeric"
            autocomplete={i === 0 ? "one-time-code" : "off"}
            maxlength={1}
            value={d}
            autofocus={autofocus && i === 0}
            aria-label={`Digit ${i + 1} of ${length}`}
          />
        ))}
      </div>
      {error && (
        <p class={cx("ia-field__error", T.bodySm)} role="alert">
          <Icon name="circle-alert" size={14} />
          {error}
        </p>
      )}
    </div>
  );
}
