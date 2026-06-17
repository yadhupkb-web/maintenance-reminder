function StatusBar({ logs }) {
  const formatTime = (timestamp) => {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  if (logs.length === 0) {
    return <div className="log-empty">No activity yet</div>;
  }

  return (
    <div className="log-list">
      {[...logs].reverse().map((entry, i) => (
        <div key={i} className={`log-item ${entry.type}`}>
          <span>{entry.message}</span>
          <span className="time">{formatTime(entry.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

export default StatusBar;
