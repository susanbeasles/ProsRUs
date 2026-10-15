export function Pagination({
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  summary,
  disabled = false,
}: {
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  summary?: string;
  disabled?: boolean;
}) {
  return (
    <nav className="pagination" aria-label="Page navigation">
      <button type="button" disabled={disabled || !canPrevious} onClick={onPrevious}>
        Previous page
      </button>
      {summary && <span className="muted">{summary}</span>}
      <button type="button" disabled={disabled || !canNext} onClick={onNext}>
        Next page
      </button>
    </nav>
  );
}
