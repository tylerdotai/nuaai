import type { ArtifactView, MessageView } from '../contracts.js';

function artifactSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function kindLabel(kind: Extract<ArtifactView, { type: 'artifact' }>['kind']): string {
  return kind.replaceAll('-', ' ');
}

export function ArtifactCards({
  message,
  resolveUrl = (path) => path,
}: {
  message: MessageView;
  resolveUrl?: (path: string) => string;
}): React.JSX.Element | null {
  if (!message.artifacts.length && !message.citations.length) return null;
  return (
    <div className="run-artifact-sections">
      {message.artifacts.length > 0 && (
        <section className="run-artifacts" aria-label="Run artifacts">
          <h3>Run artifacts</h3>
          <div className="artifact-grid">
            {message.artifacts.map((artifact) =>
              artifact.type === 'artifact' ? (
                <article
                  className="artifact-card"
                  data-artifact-kind={artifact.kind}
                  key={artifact.id}
                >
                  <div className="artifact-card-heading">
                    <span className="artifact-kind">{kindLabel(artifact.kind)}</span>
                    <span>{artifactSize(artifact.byteSize)}</span>
                  </div>
                  <strong>{artifact.title}</strong>
                  <small>
                    {artifact.mimeType} · {artifact.sourceTool}
                  </small>
                  <div className="artifact-actions">
                    {artifact.downloadUrl && (
                      <a href={resolveUrl(artifact.downloadUrl)} download={artifact.title}>
                        Download
                      </a>
                    )}
                    {artifact.externalUrl && (
                      <a href={artifact.externalUrl} target="_blank" rel="noreferrer noopener">
                        Open source
                      </a>
                    )}
                  </div>
                </article>
              ) : (
                <div
                  className="artifact-card artifact-unsupported"
                  key={`${artifact.sourceKind}:${artifact.label}`}
                >
                  {artifact.label}
                </div>
              ),
            )}
          </div>
        </section>
      )}
      {message.citations.length > 0 && (
        <section className="run-citations" aria-label="Sources">
          <h3>Sources</h3>
          <ol>
            {message.citations.map((citation) => (
              <li key={citation.id}>
                <a href={citation.url} target="_blank" rel="noreferrer noopener">
                  {citation.title}
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
