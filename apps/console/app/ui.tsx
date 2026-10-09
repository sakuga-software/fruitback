import {
  Alert,
  Description,
  Header,
  Button as HeroButton,
  Chip as HeroChip,
  Input,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  Select,
  TextField,
} from '@heroui/react';
import type { ChangeEvent, ReactNode } from 'react';

/** The pin of the widget, as the boards draw it beside the name. */
export function Mark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <path d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z" fill="#dd2c27" />
    </svg>
  );
}

type Tone = 'primary' | 'outline' | 'danger' | 'quiet';

/** The tone of a button of the boards, as the variant HeroUI draws it with. */
const VARIANTS = {
  primary: 'primary',
  outline: 'outline',
  danger: 'danger-soft',
  quiet: 'ghost',
} as const satisfies Record<Tone, string>;

type ButtonProps = {
  tone?: Tone;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
};

/**
 * A button of HeroUI (FRU-125), in the round shape of the boards.
 *
 * It takes no `title`: a tooltip does not open on a control that is disabled, so the reason a control
 * is disabled is written beside it, where a keyboard and a screen reader find it too.
 */
export function Button({
  tone = 'primary',
  type = 'button',
  disabled = false,
  onClick,
  className = '',
  children,
}: ButtonProps) {
  return (
    <HeroButton
      type={type}
      variant={VARIANTS[tone]}
      isDisabled={disabled}
      {...(onClick === undefined ? {} : { onPress: onClick })}
      className={`rounded-full font-semibold ${className}`}
    >
      {children}
    </HeroButton>
  );
}

/** The wide outlined buttons of the sign-in card. */
export function WideButton({
  disabled = false,
  onClick,
  note,
  children,
}: Pick<ButtonProps, 'disabled' | 'onClick' | 'children'> & { note?: string }) {
  const button = (
    <HeroButton
      type="button"
      variant="outline"
      size="lg"
      fullWidth
      isDisabled={disabled}
      {...(onClick === undefined ? {} : { onPress: onClick })}
      className="font-semibold"
    >
      {children}
    </HeroButton>
  );
  if (note === undefined) return button;

  // Why the button is disabled, where everybody reads it. A tooltip does not open on a disabled control.
  return (
    <div>
      {button}
      <p className="mt-1 text-center text-xs text-muted">{note}</p>
    </div>
  );
}

type FieldProps = {
  label: string;
  /** The label is for a screen reader only: the placeholder shows what to type. */
  labelHidden?: boolean;
  hint?: string;
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  type?: 'text' | 'email' | 'url' | 'password';
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
};

/** A text field of HeroUI: its label, its input, and the hint the input is described by. */
export function Field({ label, labelHidden = false, hint, disabled = false, required = false, ...input }: FieldProps) {
  return (
    <TextField fullWidth isDisabled={disabled} isRequired={required}>
      <Label className={labelHidden ? 'sr-only' : 'text-xs font-normal text-muted'}>{label}</Label>
      <Input {...input} />
      {hint === undefined ? null : <Description>{hint}</Description>}
    </TextField>
  );
}

export type Option = { value: string; label: string };
/** Options under a heading, like the teams of a tracker and their projects. */
export type OptionGroup = { heading: string; options: Option[] };

type ChoiceProps = {
  label: string;
  /** The label is for a screen reader only: the screen already says what is chosen here. */
  labelHidden?: boolean;
  /** The label is the name of a thing, like a site, and not the name of a setting. */
  labelStrong?: boolean;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (Option | OptionGroup)[];
  disabled?: boolean;
};

function item(option: Option) {
  return (
    <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
      {option.label}
      <ListBox.ItemIndicator />
    </ListBox.Item>
  );
}

/** One choice in a list, as the select of HeroUI: a button, and a list box the keyboard walks. */
export function Choice({
  label,
  labelHidden = false,
  labelStrong = false,
  hint,
  value,
  onChange,
  options,
  disabled = false,
}: ChoiceProps) {
  const quiet = labelStrong ? 'text-sm font-semibold text-ink' : 'text-xs font-normal text-muted';

  return (
    <Select
      fullWidth
      isDisabled={disabled}
      value={value}
      onChange={(chosen) => {
        if (typeof chosen === 'string') onChange(chosen);
      }}
    >
      <Label className={labelHidden ? 'sr-only' : quiet}>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {hint === undefined ? null : <Description>{hint}</Description>}
      <Select.Popover>
        <ListBox>
          {options.map((each) =>
            'options' in each ? (
              <ListBox.Section key={each.heading}>
                <Header>{each.heading}</Header>
                {each.options.map(item)}
              </ListBox.Section>
            ) : (
              item(each)
            ),
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[14px] border border-line bg-surface ${className}`}>{children}</section>;
}

type PickProps<Value extends string> = {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly { value: Value; label: string; detail: string }[];
};

/** One choice among a few, each with a line that says what it means: the radios of HeroUI. */
export function Pick<Value extends string>({ label, value, onChange, options }: PickProps<Value>) {
  return (
    <RadioGroup value={value} onChange={(chosen) => onChange(chosen as Value)}>
      <Label className="text-xs font-normal text-muted">{label}</Label>
      {options.map((option) => (
        <Radio
          key={option.value}
          value={option.value}
          className="w-full rounded-[10px] border border-line px-4 py-3 data-[selected=true]:border-ink"
        >
          {/* The row of HeroUI holds the control and the label. The detail is under it, as a description. */}
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <Label className="text-sm font-semibold">{option.label}</Label>
          </Radio.Content>
          <Description className="text-xs text-muted">{option.detail}</Description>
        </Radio>
      ))}
    </RadioGroup>
  );
}

/** The small label of a role or a state, as the members table draws it. */
export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'done' }) {
  const color = ({ neutral: 'default', accent: 'accent', done: 'success' } as const)[tone];

  return (
    <HeroChip color={color} variant="soft" size="sm" className="font-semibold">
      {children}
    </HeroChip>
  );
}

/** A problem said where it happened, with what to do about it. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <Alert status="danger" role="alert">
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

/** A name and its initial, in the round chip of the boards. */
export function Initial({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-chip text-xs font-semibold text-ink">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
