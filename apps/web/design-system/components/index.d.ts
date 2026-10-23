import type * as React from 'react';
type RN = React.ReactNode;
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Every Lucide icon the platform imports, plus the ones the components use (lucide 0.468). */
export type HighlightLanguage = 'yaml' | 'json' | 'python' | 'javascript' | 'bash' | 'sql' | 'yml' | 'py' | 'js' | 'ts' | 'typescript' | 'sh' | 'shell';
export declare function highlight(code: string, language?: string): React.ReactNode[];
export type IconName = 'activity' | 'alert-circle' | 'alert-triangle' | 'archive' | 'archive-x' | 'arrow-down' | 'arrow-down-to-line' | 'arrow-left' | 'arrow-right' | 'arrow-up' | 'arrow-up-down' | 'arrow-up-right' | 'at-sign' | 'badge-check' | 'bar-chart-3' | 'blocks' | 'book-marked' | 'book-open' | 'bookmark' | 'bot' | 'braces' | 'brain' | 'building' | 'building-2' | 'cable' | 'calendar' | 'check' | 'check-circle' | 'check-circle-2' | 'chevron-down' | 'chevron-left' | 'chevron-right' | 'chevron-up' | 'chevrons-up-down' | 'circle' | 'circle-alert' | 'circle-check' | 'circle-dot' | 'circle-x' | 'clipboard-list' | 'clock' | 'cloud' | 'code' | 'coins' | 'command' | 'copy' | 'corner-down-left' | 'cpu' | 'database' | 'download' | 'ellipsis' | 'external-link' | 'eye' | 'eye-off' | 'file' | 'file-archive' | 'file-audio' | 'file-code' | 'file-down' | 'file-image' | 'file-json' | 'file-question' | 'file-spreadsheet' | 'file-text' | 'file-type' | 'file-video' | 'filter' | 'fingerprint' | 'flag' | 'flask-conical' | 'folder-minus' | 'folder-open' | 'folder-plus' | 'gauge' | 'ghost' | 'git-branch' | 'git-compare' | 'globe' | 'grid-2x-2' | 'grip-vertical' | 'hard-drive' | 'hash' | 'history' | 'home' | 'hourglass' | 'image' | 'image-off' | 'inbox' | 'info' | 'key-round' | 'keyboard' | 'languages' | 'layers' | 'layout-grid' | 'library' | 'lightbulb' | 'link' | 'link-2' | 'list-checks' | 'loader-2' | 'lock' | 'log-out' | 'mail' | 'maximize-2' | 'menu' | 'message-circle-question' | 'message-square' | 'message-square-heart' | 'messages-square' | 'mic' | 'minimize-2' | 'minus' | 'monitor' | 'moon' | 'more-horizontal' | 'more-vertical' | 'panel-left-close' | 'panel-left-open' | 'panel-right' | 'paperclip' | 'pause' | 'pen-line' | 'pencil' | 'play' | 'plug' | 'plus' | 'presentation' | 'quote' | 'refresh-cw' | 'rotate-ccw' | 'rotate-cw' | 'save' | 'scroll-text' | 'search' | 'send' | 'server' | 'settings' | 'share' | 'share-2' | 'shield' | 'shield-alert' | 'shield-check' | 'shield-off' | 'shield-x' | 'sliders-horizontal' | 'smartphone' | 'sparkles' | 'square' | 'square-pen' | 'star' | 'stop-circle' | 'sun' | 'table' | 'tag' | 'telescope' | 'terminal' | 'thumbs-down' | 'thumbs-up' | 'timer' | 'trash' | 'trash-2' | 'trending-down' | 'trending-up' | 'triangle-alert' | 'unlink' | 'upload' | 'user' | 'user-minus' | 'user-plus' | 'users' | 'volume-2' | 'wifi-off' | 'workflow' | 'wrench' | 'x' | 'zap';

// Foundation
export declare function Icon(p: { name: IconName; size?: number; strokeWidth?: number; className?: string; /** Only when the icon carries meaning alone. */ label?: string }): React.ReactElement | null;
export declare function Spinner(p: { size?: number; label?: string }): React.ReactElement;
export declare function Avatar(p: { name?: string; src?: string; size?: number }): React.ReactElement;
export declare function AvatarStack(p: { people: { name: string; src?: string }[]; max?: number; size?: number; label?: string }): React.ReactElement;
export declare function Kbd(p: { children: RN }): React.ReactElement;
export declare function Separator(p: { orientation?: 'horizontal' | 'vertical'; label?: RN }): React.ReactElement;

// Actions
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: the one main action per view. secondary: default. quiet: toolbars. danger: destructive confirm only. */
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  /** sm 28 · md 36 · lg 44 (one step larger on touch) */
  size?: 'sm' | 'md' | 'lg';
  /** pill: website CTAs only. */
  /** Width never changes: replaces iconStart, or overlays the label when there is no icon. */
  loading?: boolean; iconStart?: IconName; iconEnd?: IconName; fullWidth?: boolean;
}
export declare function Button(p: ButtonProps): React.ReactElement;
export declare function IntraMark(p: { size?: number; /** White-label client mark. */ src?: string; label?: string; className?: string }): React.ReactElement;
export type FileKind = 'doc' | 'sheet' | 'pdf' | 'slides' | 'code' | 'other';
export declare function fileType(nameOrType?: string): { ext: string; tag: string; tone: FileKind; glyph: IconName };
export declare function FileTypeIcon(p: { name?: string; type?: string; size?: 'sm' | 'md' | 'lg'; className?: string }): React.ReactElement;
export declare function IconButton(p: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; /** Required accessible name. */ label: string; variant?: 'quiet' | 'secondary' | 'primary'; size?: 'sm' | 'md'; shape?: 'rect' | 'round'; pressed?: boolean }): React.ReactElement;
export declare function ButtonGroup(p: { children: RN; label?: string; attached?: boolean }): React.ReactElement;
export declare function CopyButton(p: { value: string | (() => string); label?: string; copiedLabel?: string; size?: 'sm' | 'md'; withText?: boolean }): React.ReactElement;
export declare function Link(p: React.AnchorHTMLAttributes<HTMLAnchorElement> & { external?: boolean; subtle?: boolean }): React.ReactElement;
export declare function Toggle(p: { pressed?: boolean; onChange?: (v: boolean) => void; icon?: IconName; children?: RN; size?: 'sm' | 'md'; disabled?: boolean }): React.ReactElement;

// Forms
export interface FieldControlProps { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; required?: boolean }
export declare function Field(p: { label?: RN; hint?: RN; error?: RN; required?: boolean; optional?: boolean; id?: string; labelAction?: RN; children: React.ReactElement | ((p: FieldControlProps) => RN) }): React.ReactElement;
export declare function Fieldset(p: { legend?: RN; description?: RN; children: RN }): React.ReactElement;
export declare function Input(p: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & { label?: RN; hint?: RN; error?: RN; optional?: boolean; iconStart?: IconName; trailing?: RN; size?: 'md' | 'lg' }): React.ReactElement;
export declare function Textarea(p: { label?: RN; hint?: RN; error?: RN; id?: string; rows?: number; maxLength?: number; value?: string; defaultValue?: string; onChange?: (v: string) => void; autoGrow?: boolean; optional?: boolean }): React.ReactElement;
export interface SelectOption { value: string; label: string; disabled?: boolean }
export declare function Select(p: { label?: RN; hint?: RN; error?: RN; id?: string; options: (SelectOption | { label: string; options: SelectOption[] })[]; placeholder?: string; value?: string; defaultValue?: string; onChange?: (v: string) => void; size?: 'md' | 'lg'; optional?: boolean }): React.ReactElement;
export declare function Combobox(p: { label?: RN; hint?: RN; error?: RN; id?: string; options: { value: string; label: string; description?: string }[]; value?: string; onChange?: (v: string) => void; placeholder?: string; emptyText?: string; defaultOpen?: boolean }): React.ReactElement;
export declare function RadioGroup(p: { legend?: RN; name?: string; options: { value: string; label: RN; description?: RN; disabled?: boolean }[]; value?: string; onChange?: (v: string) => void; variant?: 'list' | 'cards'; orientation?: 'vertical' | 'horizontal' }): React.ReactElement;
export declare function Checkbox(p: { checked?: boolean; indeterminate?: boolean; label?: RN; description?: RN; disabled?: boolean; onChange?: (v: boolean) => void; id?: string }): React.ReactElement;
export declare function Switch(p: { checked?: boolean; label?: RN; description?: RN; disabled?: boolean; onChange?: (v: boolean) => void; id?: string }): React.ReactElement;
export declare function SegmentedControl(p: { options: { value: string; label: RN; icon?: IconName }[]; value: string; onChange?: (v: string) => void; /** Required: names the group. */ label: string; size?: 'sm' | 'md' }): React.ReactElement;
export declare function Slider(p: { label: RN; value?: number; defaultValue?: number; onChange?: (v: number) => void; min?: number; max?: number; step?: number; minLabel?: RN; maxLabel?: RN; format?: (v: number) => RN; id?: string }): React.ReactElement;
export declare function TagsInput(p: { label?: RN; hint?: RN; error?: RN; id?: string; value?: string[]; defaultValue?: string[]; onChange?: (v: string[]) => void; placeholder?: string; max?: number }): React.ReactElement;
export declare function FileDropzone(p: { variant?: 'illustrated' | 'compact'; /** Button text (illustrated) or title (compact). */ label?: RN; hint?: RN; accept?: string; multiple?: boolean; onFiles?: (files: File[]) => void; disabled?: boolean; /** Types shown on the fanned cards, e.g. ['pdf','docx','xlsx']. */ types?: string[] }): React.ReactElement;
export declare function PasswordInput(p: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & { label?: RN; hint?: RN; error?: RN; requirements?: { label: string; met: boolean }[]; size?: 'md' | 'lg' }): React.ReactElement;
export declare function OtpInput(p: { length?: number; value?: string; onChange?: (v: string) => void; label?: string; error?: RN; autoFocus?: boolean }): React.ReactElement;
export declare function CodeEditor(p: { label?: RN; hint?: RN; error?: RN; id?: string; value?: string; defaultValue?: string; onChange?: (v: string) => void; language?: HighlightLanguage | 'text' | string; rows?: number; readOnly?: boolean }): React.ReactElement;

// Navigation
export declare function AppShell(p: { sidebar: RN; header?: RN; children: RN; collapsed?: boolean; mobileOpen?: boolean; onMobileClose?: () => void }): React.ReactElement;
export declare function AppHeader(p: { onToggleSidebar?: () => void; sidebarOpen?: boolean; title?: RN; /** Makes the title a button (rename, pin, delete). */ titleMenu?: () => void; start?: RN; center?: RN; end?: RN }): React.ReactElement;
export declare function Sidebar(p: { header?: RN; children: RN; footer?: RN }): React.ReactElement;
export declare function SidebarBrand(p: { name?: string; mark?: RN; href?: string; actions?: RN; onCollapse?: () => void }): React.ReactElement;
export declare function SidebarSearch(p: { label?: string; shortcut?: string[]; onClick?: () => void }): React.ReactElement;
export declare function SidebarSection(p: { label?: RN; action?: RN; children: RN }): React.ReactElement;
export declare function SidebarItem(p: { icon?: IconName; label: RN; active?: boolean; trailing?: RN; href?: string; onClick?: () => void; actions?: RN }): React.ReactElement;
export declare function PageHeader(p: { title: RN; description?: RN; breadcrumbs?: RN; actions?: RN; tabs?: RN }): React.ReactElement;
export declare function Breadcrumbs(p: { items: { label: RN; href?: string }[] }): React.ReactElement;
/** Tab ids are `${idPrefix}-tab-${value}`; give your panels id `${idPrefix}-panel-${value}`, role="tabpanel". */
export declare function Tabs(p: { tabs: { value: string; label: RN; count?: number }[]; value: string; onChange?: (v: string) => void; label: string; idPrefix?: string }): React.ReactElement;
export declare function SettingsNav(p: { sections: { label?: RN; items: { value: string; label: RN; icon?: IconName }[] }[]; value: string; onChange?: (v: string) => void; label?: string }): React.ReactElement;
export type MenuItem = { label: RN; description?: RN; icon?: IconName; shortcut?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect?: () => void } | { group: RN } | 'separator';
export declare function Menu(p: { items: MenuItem[]; label?: string; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; align?: 'start' | 'end'; trigger?: (api: { open: boolean; toggle: (e?: React.SyntheticEvent) => void }) => RN }): React.ReactElement;
export declare function CommandPalette(p: { open?: boolean; onClose?: () => void; groups: { label: string; items: { id: string; label: string; description?: string; icon?: IconName; shortcut?: string }[] }[]; onSelect?: (item: any) => void; placeholder?: string; contained?: boolean }): React.ReactElement | null;
export declare function Pagination(p: { page: number; pageCount: number; onChange?: (page: number) => void; total?: number; pageSize?: number }): React.ReactElement;
export declare function Stepper(p: { steps: { label: RN; description?: RN }[]; current: number; orientation?: 'horizontal' | 'vertical' }): React.ReactElement;

// Feedback
export declare function Badge(p: { tone?: Tone; icon?: IconName | false; children: RN }): React.ReactElement;
export declare function StatusDot(p: { tone?: Tone; label: RN; pulse?: boolean }): React.ReactElement;
export declare function Banner(p: { tone?: Exclude<Tone, 'neutral'>; title?: RN; children?: RN; action?: RN; onDismiss?: () => void }): React.ReactElement;
export declare function Callout(p: { tone?: Exclude<Tone, 'neutral'>; title?: RN; children: RN }): React.ReactElement;
export declare function Toast(p: { tone?: Tone; title: RN; description?: RN; action?: { label: string; onClick: () => void }; onDismiss?: () => void }): React.ReactElement;
export declare function ProgressBar(p: { value?: number; max?: number; label?: string; showValue?: boolean; indeterminate?: boolean }): React.ReactElement;
export declare function Meter(p: { value: number; max: number; label: string; format?: (n: number) => string; warnAt?: number; dangerAt?: number; caption?: RN }): React.ReactElement;
export declare function Skeleton(p: { width?: number | string; height?: number | string; radius?: string; lines?: number }): React.ReactElement;
export declare function EmptyState(p: { icon?: IconName; title: RN; description?: RN; action?: RN; secondary?: RN; align?: 'center' | 'start' }): React.ReactElement;
export declare function ErrorState(p: { title?: RN; description?: RN; detail?: string; onRetry?: () => void; secondary?: RN }): React.ReactElement;

// Overlays
export declare function Tooltip(p: { content: RN; children: React.ReactElement; side?: 'top' | 'bottom'; delay?: number }): React.ReactElement;
export declare function Popover(p: { trigger: (api: { open: boolean; toggle: () => void; 'aria-expanded': boolean; 'aria-controls': string }) => RN; children: RN; open?: boolean; defaultOpen?: boolean; onOpenChange?: (o: boolean) => void; align?: 'start' | 'end'; width?: number; label?: string }): React.ReactElement;
/** sm 440 (confirm) · md 560 (short form) · lg 720 (editor). Header and footer fixed, body scrolls. */
export declare function Dialog(p: { open?: boolean; title: RN; description?: RN; children?: RN; actions?: RN; footerStart?: RN; onClose?: () => void; size?: 'sm' | 'md' | 'lg'; contained?: boolean }): React.ReactElement | null;
export declare function ConfirmDialog(p: { open?: boolean; title: RN; description?: RN; confirmLabel: string; cancelLabel?: string; tone?: 'danger' | 'primary'; onConfirm?: () => void; onCancel?: () => void; loading?: boolean; contained?: boolean }): React.ReactElement | null;
/** md 480 · lg 640 */
export declare function Sheet(p: { open?: boolean; title: RN; description?: RN; children: RN; actions?: RN; onClose?: () => void; size?: 'md' | 'lg'; side?: 'right' | 'left'; contained?: boolean }): React.ReactElement | null;
export declare function CoachMark(p: { title: RN; children?: RN; step: number; total: number; onNext?: () => void; onSkip?: () => void; nextLabel?: string; side?: 'top' | 'bottom' }): React.ReactElement;

// Data
export declare function Surface(p: { title?: RN; description?: RN; children?: RN; interactive?: boolean; href?: string; footer?: RN; padding?: 'sm' | 'md' | 'lg' }): React.ReactElement;
export interface TableColumn<R = any> { key: string; label: RN; numeric?: boolean; mono?: boolean; sortable?: boolean; rowHeader?: boolean; width?: number | string; render?: (row: R) => RN }
export declare function Table<R = any>(p: { columns: TableColumn<R>[]; rows: R[]; caption?: string; sort?: { key: string; dir: 'asc' | 'desc' }; onSort?: (s: { key: string; dir: 'asc' | 'desc' }) => void; rowKey?: (r: R, i: number) => React.Key; onRowClick?: (r: R) => void; density?: 'sm' | 'md'; stickyHeader?: boolean; empty?: RN }): React.ReactElement;
export declare function DescriptionList(p: { items: { label: RN; value: RN; mono?: boolean; numeric?: boolean }[]; layout?: 'row' | 'stack' }): React.ReactElement;
export declare function ListRow(p: { leading?: RN; title: RN; description?: RN; meta?: RN; trailing?: RN; href?: string; onClick?: () => void; active?: boolean }): React.ReactElement;
export declare function EntityCard(p: { avatar?: RN; title: RN; description?: RN; meta?: RN; badges?: RN; actions?: RN; href?: string; onClick?: () => void }): React.ReactElement;
export declare function StatTile(p: { label: RN; value: RN; unit?: RN; delta?: RN; deltaLabel?: RN; trend?: 'up-good' | 'up-bad' | 'down-good' | 'down-bad'; caption?: RN }): React.ReactElement;
export declare function ChartFrame(p: { title: RN; description?: RN; legend?: string[]; children: RN; actions?: RN; footnote?: RN }): React.ReactElement;
export declare function Timeline(p: { items: { title: RN; time: RN; datetime?: string; description?: RN; current?: boolean; badge?: RN; children?: RN }[] }): React.ReactElement;
export declare function Accordion(p: { items: { id?: React.Key; title: RN; content: RN }[]; defaultOpen?: React.Key[]; multiple?: boolean }): React.ReactElement;
export declare function DiffView(p: { lines: { type: 'add' | 'del' | 'ctx'; text: string }[]; title?: RN }): React.ReactElement;
export declare function JsonView(p: { data: unknown; maxHeight?: number }): React.ReactElement;
export declare function Chip(p: { children: RN; selected?: boolean; onToggle?: (v: boolean) => void; onRemove?: () => void; icon?: IconName }): React.ReactElement;
export declare function FileRow(p: { name: string; size?: string; status?: 'processing' | 'ready' | 'failed'; meta?: string; actions?: RN; progress?: number }): React.ReactElement;

// AI
export declare function Composer(p: { placeholder?: string; value?: string; defaultValue?: string; onChange?: (v: string) => void; onSubmit?: (v: string) => void; tools?: { id: string; label: string; icon?: IconName; on?: boolean; hint?: string }[]; onToggleTool?: (id: string) => void; thinking?: ThinkingControlProps; markdown?: boolean; onToggleMarkdown?: () => void; onVoice?: () => void; onAttach?: () => void; remaining?: string; busy?: boolean; onStop?: () => void; disabled?: boolean; footnote?: RN; attachments?: RN }): React.ReactElement;
export interface ThinkingControlProps { enabled?: boolean; level?: 'low' | 'medium' | 'high'; onChange?: (v: { enabled: boolean; level: 'low' | 'medium' | 'high' }) => void; /** Provider honours effort levels. */ effort?: boolean; /** Agent name when the agent sets reasoning. */ lockedBy?: string; defaultOpen?: boolean }
export declare function ThinkingControl(p: ThinkingControlProps): React.ReactElement;
export declare function Message(p: { role?: 'user' | 'assistant'; author?: string; /** Assistant avatar: the Intra mark or an AgentAvatar. */ mark?: RN; meta?: RN; children: RN; actions?: RN; streaming?: boolean }): React.ReactElement;
export declare function MessageActions(p: { text: string; onRetry?: () => void; onFeedback?: (v: 'up' | 'down') => void; feedback?: 'up' | 'down'; extra?: RN }): React.ReactElement;
export declare function AgentAvatar(p: { name?: string; icon?: IconName; size?: number; variant?: 'agent' | 'neutral' }): React.ReactElement;
export declare function ToolCall(p: { icon?: IconName; label: RN; detail?: RN; status?: 'running' | 'done' | 'error'; duration?: string; params?: string; result?: string; defaultOpen?: boolean }): React.ReactElement;
export declare function AgentRun(p: { name: string; icon?: IconName; status?: 'running' | 'done' | 'error'; steps?: { label: RN; status?: 'done' | 'running' | 'pending' }[]; summary?: RN; elapsed?: string; onOpen?: () => void }): React.ReactElement;
export declare function ThinkingBlock(p: { children: RN; seconds?: number; streaming?: boolean; defaultOpen?: boolean }): React.ReactElement;
export declare function SourceList(p: { sources: { type?: 'file' | 'web'; title: string; origin?: string; href?: string; favicon?: string }[]; label?: string }): React.ReactElement;
export declare function Citation(p: { n: number; href?: string; title: string }): React.ReactElement;
export declare function CodeBlock(p: { code?: string; language?: HighlightLanguage | string; filename?: string; children?: RN }): React.ReactElement;
export interface ModelOption { value: string; name: string; /** Where it runs: IONOS, STACKIT, … Rows are grouped by it. */ host?: string; /** e.g. '262k'. */ context?: string; reasoning?: boolean; vision?: boolean; /** Vendor logo URL shipped by the app. */ logo?: string; note?: string; disabled?: boolean }
export declare function ModelSelector(p: { models: ModelOption[]; value: string; onChange?: (v: string) => void; defaultOpen?: boolean; variant?: 'button' | 'segment'; imagesAttached?: boolean; align?: 'start' | 'end' }): React.ReactElement;
export declare function ModelLogo(p: { name?: string; src?: string; size?: number }): React.ReactElement;
export declare function ContextSwitcher(p: { agent?: { name: string; icon?: IconName } | null; onUseDefault?: () => void; onOpenAgents?: () => void; locked?: boolean; /** A ModelSelector with variant="segment". */ model?: RN; baseName?: string; baseMark?: RN; agentsLabel?: string }): React.ReactElement;
export interface AgentOption { id: string; name: string; icon?: IconName; description?: string; scope?: string; category?: string; starters?: string[]; tools?: { name: string; icon?: IconName; logo?: string; count?: number }[]; subAgents?: string[]; files?: number }
export declare function AgentPicker(p: { open?: boolean; onClose?: () => void; onSelect?: (agent: AgentOption | null, prompt?: string) => void; agents: AgentOption[]; recentIds?: string[]; value?: string | null; defaultAgent?: { name: string; description?: string }; favorites?: string[]; onToggleFavorite?: (id: string) => void; contained?: boolean }): React.ReactElement | null;
export declare function ArtifactCard(p: { title: string; /** File type; else taken from the title's extension. */ type?: string; kind?: string; /** For results that are not files (chart, table). */ icon?: IconName; meta?: string; onOpen?: () => void; actions?: RN }): React.ReactElement;
export declare function ArtifactPanel(p: { title: string; meta?: RN; actions?: RN; onClose?: () => void; children: RN }): React.ReactElement;
export declare function TurnStatus(p: { label: RN; elapsed?: string; icon?: IconName }): React.ReactElement;
export declare function ConversationDivider(p: { label: string; icon?: IconName }): React.ReactElement;
export declare function DecisionCard(p: { question: RN; options: { value: string; label: RN; description?: RN }[]; onChoose?: (v: string) => void; value?: string; allowOther?: boolean }): React.ReactElement;
export declare function PromptSuggestions(p: { items: { title: RN; description?: RN }[]; onPick?: (item: any) => void; label?: string }): React.ReactElement;
export declare function VoiceRecorder(p: { elapsed?: string; levels?: number[]; onCancel?: () => void; onDone?: () => void; transcribing?: boolean }): React.ReactElement;

// Marketing (website)
export declare function SectionHeader(p: { title: RN; description?: RN; align?: 'start' | 'center'; as?: 'h1' | 'h2' | 'h3'; actions?: RN }): React.ReactElement;
export declare function Navbar(p: { logo: RN; links: { href: string; label: RN }[]; current?: string; actions?: RN; languageToggle?: RN }): React.ReactElement;
export declare function Footer(p: { logo: RN; columns: { title: string; links: { href: string; label: RN }[] }[]; legal?: RN; note?: RN }): React.ReactElement;
export declare function Hero(p: { title: RN; description?: RN; actions?: RN; media?: RN; note?: RN; align?: 'start' | 'center' }): React.ReactElement;
export declare function FeatureSplit(p: { title: RN; description?: RN; points?: { title: RN; text?: RN }[]; media: RN; reverse?: boolean; action?: RN }): React.ReactElement;
export declare function MediaFrame(p: { src?: string; alt?: string; ratio?: string; children?: RN; caption?: RN }): React.ReactElement;
export declare function LogoCloud(p: { title?: RN; logos: { name: string; src?: string }[] }): React.ReactElement;
export declare function PricingCard(p: { name: RN; description?: RN; price: RN; period?: RN; priceNote?: RN; features?: string[]; action?: RN; recommended?: boolean }): React.ReactElement;
export declare function FAQ(p: { title?: RN; items: { question: RN; answer: RN }[] }): React.ReactElement;
export declare function CTABand(p: { title: RN; description?: RN; actions?: RN }): React.ReactElement;
export declare function SpecList(p: { items: { label: RN; value: RN }[] }): React.ReactElement;
export declare function ComparisonTable(p: { columns: RN[]; rows: { label: RN; values: (boolean | RN)[] }[]; caption?: string }): React.ReactElement;
export declare function LanguageToggle(p: { value?: string; onChange?: (v: string) => void; languages?: { value: string; label: string; name: string }[] }): React.ReactElement;

declare global { interface Window { Intra: Record<string, any> & { ICON_NAMES: IconName[] } } }
