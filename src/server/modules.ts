import "server-only";
// Side-effect imports: each module registers its background jobs, checks, remedies and search providers.
import "./metrics";
import "./docker/events";
import "./docker";
import "./alerts/engine";
import "./alerts/core-checks";
import "./system";
import "./integrations";
import "./files";
import "./network";
import "./diagnostics";
import "./monitors";
import "./notify";
import "./people";
import "./storage";
import "./updates";
export {};
