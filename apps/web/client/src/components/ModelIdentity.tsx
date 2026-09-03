interface ModelIdentityProps {
  name: string;
  lab: string;
  color: string;
  compact?: boolean;
}

export function ModelIdentity({ name, lab, color, compact = false }: ModelIdentityProps) {
  return (
    <div className={`model-identity${compact ? " model-identity--compact" : ""}`}>
      <span className="model-avatar" style={{ backgroundColor: color }} aria-hidden="true">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="model-names">
        <strong>{name}</strong>
        <small>{lab}</small>
      </span>
    </div>
  );
}
