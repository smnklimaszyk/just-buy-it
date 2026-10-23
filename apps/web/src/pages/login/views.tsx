import { Button, ButtonLink } from "../../ui/core.js";
import { renderDocument } from "../../ui/document.js";
import { Callout } from "../../ui/feedback.js";
import { Input, OtpInput } from "../../ui/forms.js";
import type { AssetManifest } from "../../ui/assets.js";
import { T } from "../../ui/shared.js";

// Spec 7.2: the one reply to every address.
export const CODE_SENT = "If this address is approved, a code is on its way. It is valid for 10 minutes.";

// Spec 7.2: the one message for every failed code (wrong, expired, used, locked, capped).
export const CODE_FAILED = "That code did not work. Check the newest mail or ask for a new code.";

// `ref` is null once the attempt can take no more codes.
export function codePage(input: {
  assets: AssetManifest;
  theme: "light" | "dark";
  formToken: string;
  ref: string | null;
  failed?: boolean;
}): string {
  return renderDocument({
    title: "Enter your code",
    theme: input.theme,
    assets: input.assets,
    scripts: ["otp"],
    children: (
      <main id="main" class="app-page app-narrow">
        <h1 class={T.titleLg}>Enter your code</h1>
        <Callout tone="info">{CODE_SENT}</Callout>
        <form method="post" action="/login/code" class="app-stack">
          <input type="hidden" name="_csrf" value={input.formToken} />
          <OtpInput length={8} label="Sign-in code" name="code" autofocus error={input.failed === true ? CODE_FAILED : undefined} />
          {input.ref !== null && <p class={T.bodySm}>Reference {input.ref}</p>}
          <Button type="submit" variant="primary" size="lg">
            Sign in
          </Button>
        </form>
        {/* A mistyped address, or a new code: back to the address form. */}
        <ButtonLink href="/login" variant="secondary" size="lg">
          Use another address
        </ButtonLink>
      </main>
    ),
  });
}

// The sign-in pages (spec 8.3): a narrow form, Input lg, Button lg, no sidebar.

// `email` and `invalid`: what was typed, when it was not one address.
export function loginPage(input: { assets: AssetManifest; theme: "light" | "dark"; formToken: string; email?: string; invalid?: boolean }): string {
  return renderDocument({
    title: "Sign in",
    theme: input.theme,
    assets: input.assets,
    children: (
      <main id="main" class="app-page app-narrow">
        <h1 class={T.titleLg}>Sign in to Just-Buy-It</h1>
        <form method="post" action="/login" class="app-stack">
          <input type="hidden" name="_csrf" value={input.formToken} />
          <Input
            id="email"
            name="email"
            type="email"
            autocomplete="email"
            size="lg"
            label="Email address"
            required
            value={input.email ?? ""}
            error={input.invalid === true ? "Enter one email address, like name@example.com." : undefined}
          />
          <Button type="submit" variant="primary" size="lg">
            Send code
          </Button>
        </form>
      </main>
    ),
  });
}
