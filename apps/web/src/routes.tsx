import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import { activityRoutes } from "./pages/activity/routes.js";
import { budgetRoutes } from "./pages/budget/routes.js";
import { dealsRoutes } from "./pages/deals/routes.js";
import { overviewRoutes } from "./pages/overview/routes.js";
import { peopleRoutes } from "./pages/people/routes.js";
import { productRoutes } from "./pages/products/routes.js";
import { settingsRoutes } from "./pages/settings/routes.js";
import type { AppEnv } from "./session.js";

// Spec 8.3: the page modules of V6a (products), V6b (budget, settings, people, activity) and V6c
// (overview, deals).
export function mountPages(app: Hono<AppEnv>, deps: AppDeps): void {
  app.route("/", overviewRoutes(deps));
  app.route("/deals", dealsRoutes(deps));
  app.route("/products", productRoutes(deps));
  app.route("/budget", budgetRoutes(deps));
  app.route("/settings", settingsRoutes(deps));
  app.route("/people", peopleRoutes(deps));
  app.route("/activity", activityRoutes(deps));
}
