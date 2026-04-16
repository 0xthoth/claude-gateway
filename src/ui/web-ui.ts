/**
 * Generates a self-contained HTML dashboard page for the gateway status UI.
 * No external dependencies — all CSS and JS is inline.
 */
export function generateDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Gateway Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0f1117;
      color: #e2e8f0;
      padding: 24px;
    }
    h1 { color: #63b3ed; font-size: 1.5rem; margin-bottom: 8px; }
    .meta { color: #718096; font-size: 0.85rem; margin-bottom: 24px; }
    .meta span { color: #a0aec0; }
    h2 { color: #90cdf4; font-size: 1.1rem; margin: 20px 0 10px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
      margin-bottom: 24px;
    }
    th {
      background: #1a202c;
      color: #718096;
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid #2d3748;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid #1a202c;
    }
    tr:hover td { background: #1a202c; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-green { background: #22543d; color: #68d391; }
    .badge-red { background: #742a2a; color: #fc8181; }
    .badge-gray { background: #2d3748; color: #a0aec0; }
    .ts { color: #718096; font-size: 0.8rem; }
    #refresh-indicator {
      float: right;
      font-size: 0.75rem;
      color: #4a5568;
    }
    .error { color: #fc8181; font-size: 0.85rem; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Claude Gateway <span id="refresh-indicator">refreshing...</span></h1>
  <div class="meta">
    Uptime: <span id="uptime">—</span> &nbsp;|&nbsp;
    Started: <span id="started-at">—</span> &nbsp;|&nbsp;
    Last updated: <span id="last-updated">—</span>
  </div>

  <h2>Agents</h2>
  <table id="agents-table">
    <thead>
      <tr>
        <th>ID</th>
        <th>Status</th>
        <th>Received</th>
        <th>Sent</th>
        <th>Last Activity</th>
      </tr>
    </thead>
    <tbody id="agents-tbody">
      <tr><td colspan="5" class="ts">Loading...</td></tr>
    </tbody>
  </table>

  <h2>Heartbeat Tasks</h2>
  <table id="heartbeat-table">
    <thead>
      <tr>
        <th>Agent</th>
        <th>Task</th>
        <th>Last Run</th>
        <th>Result</th>
      </tr>
    </thead>
    <tbody id="heartbeat-tbody">
      <tr><td colspan="4" class="ts">Loading...</td></tr>
    </tbody>
  </table>

  <h2>Recent Sessions (last 5 per agent)</h2>
  <table id="sessions-table">
    <thead>
      <tr>
        <th>Agent</th>
        <th>Chat ID</th>
        <th>Messages</th>
        <th>Last Activity</th>
      </tr>
    </thead>
    <tbody id="sessions-tbody">
      <tr><td colspan="4" class="ts">Loading...</td></tr>
    </tbody>
  </table>

  <div id="error-msg" class="error" style="display:none;"></div>

  <script>
    function fmtUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function fmtTs(ts) {
      if (!ts) return '<span class="ts">—</span>';
      try {
        const d = new Date(ts);
        return '<span class="ts">' + d.toLocaleTimeString() + ' ' + d.toLocaleDateString() + '</span>';
      } catch(e) { return ts; }
    }

    function badge(running) {
      return running
        ? '<span class="badge badge-green">running</span>'
        : '<span class="badge badge-red">stopped</span>';
    }

    function resultBadge(suppressed, rateLimited) {
      if (rateLimited) return '<span class="badge badge-gray">rate-limited</span>';
      if (suppressed) return '<span class="badge badge-gray">suppressed</span>';
      return '<span class="badge badge-green">sent</span>';
    }

    async function refresh() {
      document.getElementById('refresh-indicator').textContent = 'refreshing...';
      try {
        const res = await fetch('/status');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        document.getElementById('uptime').textContent = fmtUptime(data.uptime || 0);
        document.getElementById('started-at').textContent = data.startedAt
          ? new Date(data.startedAt).toLocaleString() : '—';
        document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        document.getElementById('error-msg').style.display = 'none';

        // Agents table
        const agentRows = (data.agents || []).map(function(a) {
          return '<tr>' +
            '<td>' + a.id + '</td>' +
            '<td>' + badge(a.isRunning) + '</td>' +
            '<td>' + (a.messagesReceived || 0) + '</td>' +
            '<td>' + (a.messagesSent || 0) + '</td>' +
            '<td>' + fmtTs(a.lastActivityAt) + '</td>' +
            '</tr>';
        });
        document.getElementById('agents-tbody').innerHTML =
          agentRows.length ? agentRows.join('') : '<tr><td colspan="5" class="ts">No agents</td></tr>';

        // Heartbeat table
        const hbRows = [];
        (data.agents || []).forEach(function(a) {
          const lastResults = (a.heartbeat && a.heartbeat.lastResults) || [];
          lastResults.forEach(function(r) {
            if (!r) return;
            hbRows.push('<tr>' +
              '<td>' + a.id + '</td>' +
              '<td>' + r.taskName + '</td>' +
              '<td>' + fmtTs(r.ts) + '</td>' +
              '<td>' + resultBadge(r.suppressed, r.rateLimited) + '</td>' +
              '</tr>');
          });
        });
        document.getElementById('heartbeat-tbody').innerHTML =
          hbRows.length ? hbRows.join('') : '<tr><td colspan="4" class="ts">No heartbeat data yet</td></tr>';

        // Sessions table
        const sessRows = [];
        (data.agents || []).forEach(function(a) {
          const sessions = (a.sessions || []).slice(0, 5);
          sessions.forEach(function(s) {
            sessRows.push('<tr>' +
              '<td>' + a.id + '</td>' +
              '<td>' + s.chatId + '</td>' +
              '<td>' + (s.messageCount || 0) + '</td>' +
              '<td>' + fmtTs(s.lastActivity) + '</td>' +
              '</tr>');
          });
        });
        document.getElementById('sessions-tbody').innerHTML =
          sessRows.length ? sessRows.join('') : '<tr><td colspan="4" class="ts">No sessions yet</td></tr>';

        document.getElementById('refresh-indicator').textContent = 'auto-refresh 5s';
      } catch(e) {
        document.getElementById('error-msg').textContent = 'Error fetching status: ' + e.message;
        document.getElementById('error-msg').style.display = 'block';
        document.getElementById('refresh-indicator').textContent = 'error';
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
