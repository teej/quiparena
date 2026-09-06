import type { ReactNode } from "react";
import { Link } from "react-router";

export function ModelLink({ modelId, children }: { modelId: string | null | undefined; children: ReactNode }) {
  return modelId ? <Link to={`/models/${encodeURIComponent(modelId)}`}>{children}</Link> : <>{children}</>;
}
