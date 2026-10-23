// One page with every reference case and the port's own pieces, inside the real shell, with all
// page scripts loaded. Asset names are fixed (/assets/styles.css, /assets/otp.js, ...) so a
// local server can map them to the hashed files of dist/assets/manifest.json.
import { CLIENT_SCRIPTS, type AssetManifest, type ClientScript } from "../assets.js";
import { Button, ButtonLink } from "../core.js";
import { renderDocument, ThemeToggle, type Theme } from "../document.js";
import { Toast, ToastRegion } from "../feedback.js";
import { Fieldset, Input, OtpInput, TagsInput } from "../forms.js";
import { AppHeader, AppShell, DrawerToggle, PageHeader, Sidebar, SidebarBrand, SidebarItem, SidebarSection } from "../navigation.js";
import { ConfirmDialog, Dialog } from "../overlays.js";
import { REFERENCE_CASES } from "./reference-cases.js";
import { caseToJsx } from "./render-case.js";

const GALLERY_ASSETS: AssetManifest = {
  styles: "/assets/styles.css",
  fonts: { geist: "/assets/Geist-Variable.woff2", geistItalic: "/assets/Geist-Italic-Variable.woff2", geistMono: "/assets/GeistMono-Variable.woff2" },
  scripts: Object.fromEntries(CLIENT_SCRIPTS.map((s) => [s, `/assets/${s}.js`])) as Record<ClientScript, string>,
};

function GallerySidebar({ theme }: { theme: Theme }) {
  return (
    <Sidebar
      header={<SidebarBrand name="Just-Buy-It" />}
      footer={[
        <SidebarItem icon="user" label="Account" href="/account" />,
        <ThemeToggle theme={theme} csrfToken="gallery" back="/gallery" />,
        <SidebarItem icon="log-out" label="Sign out" type="submit" form="sign-out" />,
      ]}
    >
      <SidebarSection label="Watch">
        <SidebarItem icon="home" label="Overview" href="/" />
        <SidebarItem icon="tag" label="Deals" href="/deals" />
        <SidebarItem icon="layers" label="Products" href="/products" active />
      </SidebarSection>
      <SidebarSection label="Platform">
        <SidebarItem icon="gauge" label="Budget" href="/budget" />
        <SidebarItem icon="settings" label="Settings" href="/settings" />
        <SidebarItem icon="users" label="People" href="/people" />
        <SidebarItem icon="activity" label="Activity" href="/activity" />
      </SidebarSection>
    </Sidebar>
  );
}

function Interactive() {
  return (
    <section class="app-gallery__case" aria-labelledby="g-interactive">
      <h2 id="g-interactive" class="type-title">
        Page scripts
      </h2>
      <form class="app-stack" method="post" action="/gallery" data-busy="">
        <Fieldset legend="Product words" description="tags.ts turns the comma list into chips; form-busy.ts adds the spinner after 300 ms.">
          <TagsInput id="g-tags" name="search" label="Search words" value={["road bike", "56 cm"]} max={8} />
          <Input id="g-name" name="name" label="Name" value="Road bike 56 cm" />
        </Fieldset>
        <div class="app-row">
          <Button type="submit" variant="primary">
            Save changes
          </Button>
          <Button commandfor="g-dialog" command="show-modal">
            Add person
          </Button>
          <Button commandfor="g-confirm" command="show-modal">
            Archive product
          </Button>
          <ButtonLink href="/products">Cancel</ButtonLink>
        </div>
      </form>
      <form method="post" action="/login/code">
        <OtpInput length={8} label="Sign-in code" name="code" />
      </form>
      <Dialog id="g-dialog" title="Add person" description="They get a sign-in code by email." size="md" actions={<Button variant="primary">Add person</Button>}>
        <Input id="g-email" name="email" type="email" label="Email address" />
      </Dialog>
      <ConfirmDialog id="g-confirm" title="Archive this product?" description="It stops polling. Its deals stay." confirmLabel="Archive product" action="/gallery" />
    </section>
  );
}

export function renderGallery(theme: Theme): string {
  return renderDocument({
    title: "Component gallery",
    theme,
    assets: GALLERY_ASSETS,
    scripts: [...CLIENT_SCRIPTS],
    children: (
      <AppShell
        drawerId="sidebar"
        sidebar={<GallerySidebar theme={theme} />}
        header={<AppHeader start={<DrawerToggle drawerId="sidebar" />} end={<Button variant="quiet" size="sm">Help</Button>} />}
      >
        <div class="app-page">
          <PageHeader title="Component gallery" description="Every component of the UI kit, as the pages render it." />
          <Interactive />
          {REFERENCE_CASES.map((c, i) => (
            <section class="app-gallery__case" aria-labelledby={`g-case-${i}`}>
              <h2 id={`g-case-${i}`} class="type-title-sm">
                {c.id}
              </h2>
              <div>{caseToJsx(c.node)}</div>
            </section>
          ))}
        </div>
        <ToastRegion>
          <Toast tone="success" title="Product saved" description="Polling starts within a minute." />
        </ToastRegion>
      </AppShell>
    ),
  });
}
