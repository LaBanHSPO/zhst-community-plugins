/**
 * Admin entrypoint. EmDash imports this module for `adminEntry` and mounts the
 * component registered for the page path declared in `otaServerPlugin()`.
 */

import type { ComponentType } from "react";
import Workspace from "./workspace.js";

export const pages: Record<string, ComponentType> = { "/workspace": Workspace };

export default { pages };
