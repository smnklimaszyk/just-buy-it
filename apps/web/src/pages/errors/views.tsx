import type { AssetManifest } from "../../ui/assets.js";
import { renderDocument } from "../../ui/document.js";
import { ErrorState } from "../../ui/feedback.js";

// The error pages of spec 8.3.
const ERRORS = {
  403: { title: "Not allowed", description: "Only admins can change this. Ask an admin." },
  404: { title: "Not found", description: "This page does not exist." },
  500: { title: "Something went wrong", description: "The page could not load. Nothing was changed." },
} as const;

export function errorPage(input: { status: keyof typeof ERRORS; assets: AssetManifest }): string {
  const { title, description } = ERRORS[input.status];
  return renderDocument({
    title,
    theme: "light",
    assets: input.assets,
    children: (
      <main id="main" class="app-page">
        <ErrorState title={title} description={description} />
      </main>
    ),
  });
}
