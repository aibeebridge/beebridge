"use client";

interface BeePersona {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  flowerType: string;
}

interface TeamPreviewProps {
  bees: BeePersona[];
}

export function TeamPreview({ bees }: TeamPreviewProps) {
  if (!bees || bees.length === 0) return null;

  return (
    <div className="team-preview">
      <h3>Team ({bees.length} Bees)</h3>
      <div className="team-cards">
        {bees.map((bee) => (
          <div key={bee.id} className="persona-card compact">
            <div className="persona-header">
              <span className="persona-number">{bee.name}</span>
              <span className="approval-badge">{bee.role}</span>
            </div>
            <div className="persona-fields">
              <p style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0" }}>
                {bee.systemPrompt}
              </p>
              <div className="persona-row" style={{ fontSize: 12 }}>
                <span>AI: {bee.providerId}/{bee.model}</span>
                <span>Flower: {bee.flowerType}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
