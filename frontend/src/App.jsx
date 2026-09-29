import { useEffect, useRef, useState } from 'react'
import {
  Activity, AlertOctagon, AlertTriangle, ArrowDown, ArrowUpRight, Bot, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3,
  Command, FileText, Filter, Gauge, LayoutDashboard, ListFilter, LoaderCircle,
  Menu, MessageSquare, Plus, RefreshCw, RotateCcw, Search, Send, Shield,
  ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, UserRound, X, Zap,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
const SEVERITIES = ['SEV-1', 'SEV-2', 'SEV-3', 'SEV-4']
const STATUSES = ['OPEN', 'INVESTIGATING', 'CONTAINED', 'RESOLVED']

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      message = typeof body.detail === 'string' ? body.detail : message
    } catch { /* retain status message */ }
    throw new Error(message)
  }
  return response.status === 204 ? null : response.json()
}

function App() {
  const [page, setPage] = useState('Overview')
  const [incidents, setIncidents] = useState([])
  const [health, setHealth] = useState('checking')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notifications, setNotifications] = useState([])
  const [selected, setSelected] = useState(null)
  const [events, setEvents] = useState([])
  const [investigation, setInvestigation] = useState(null)
  const [recommendation, setRecommendation] = useState(null)
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState('All severities')
  const [status, setStatus] = useState('All statuses')
  const [sort, setSort] = useState('Newest first')
  const [dialog, setDialog] = useState('')
  const [busy, setBusy] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [agentMessages, setAgentMessages] = useState([{
    id: 'welcome',
    role: 'assistant',
    type: 'text',
    text: "Hello! I'm Sentinel, your Incident Response Agent. Describe the issue and I’ll help investigate it using Operations Memory.",
    createdAt: new Date().toISOString(),
  }])
  const [agentDraft, setAgentDraft] = useState('')
  const [agentContext, setAgentContext] = useState({})

  function notify(message, type = 'success') {
    const id = `${Date.now()}-${Math.random()}`
    setNotifications((items) => [...items, { id, message, type }])
    window.setTimeout(() => setNotifications((items) => items.filter((item) => item.id !== id)), 6000)
  }

  async function loadIncidents(initial = false) {
    if (initial) setLoading(true)
    else setRefreshing(true)
    try {
      const data = await request('/api/incidents')
      setIncidents(Array.isArray(data) ? data : [])
      setError('')
    } catch (err) {
      setError(err.message)
      if (initial) notify(`API unavailable: ${err.message}`, 'error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  async function checkHealth() {
    try {
      await request('/api/health')
      setHealth('online')
    } catch {
      setHealth('offline')
    }
  }

  useEffect(() => {
    loadIncidents(true)
    checkHealth()
    const timer = window.setInterval(() => {
      loadIncidents()
      checkHealth()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [])

  async function openIncident(incident) {
    setSelected(incident)
    setInvestigation(null)
    setRecommendation(null)
    try {
      const [details, timeline] = await Promise.all([
        request(`/api/incidents/${encodeURIComponent(incident.incident_id)}`),
        request(`/api/incidents/${encodeURIComponent(incident.incident_id)}/events`),
      ])
      setSelected(details)
      setEvents(Array.isArray(timeline) ? timeline : [])
    } catch (err) {
      setEvents([])
      notify(`Unable to load incident details: ${err.message}`, 'error')
    }
  }

  async function runInvestigation(incidentId) {
    setBusy('investigate')
    try {
      const result = await request(`/api/incidents/${encodeURIComponent(incidentId)}/investigate`, { method: 'POST' })
      setInvestigation(result)
      await request(`/api/incidents/${encodeURIComponent(incidentId)}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'investigate', detail: 'Investigation requested by SOC operator' }),
      })
      await loadIncidents()
      if (selected?.incident_id === incidentId) {
        setEvents(await request(`/api/incidents/${encodeURIComponent(incidentId)}/events`))
      }
      notify('Incident analysis completed')
    } catch (err) {
      notify(`Unable to analyze incident: ${err.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  async function performAction(incidentId, action, detail = '', shouldNotify = true, assignedTo = '') {
    setBusy(action)
    try {
      await request(`/api/incidents/${encodeURIComponent(incidentId)}/actions`, {
        method: 'POST', body: JSON.stringify({ action, detail, assigned_to: assignedTo }),
      })
      await loadIncidents()
      if (selected?.incident_id === incidentId) await openIncident({ ...selected, incident_id: incidentId })
      if (shouldNotify) notify(`${actionLabel(action)} recorded`)
      return true
    } catch (err) {
      notify(`Unable to ${actionLabel(action).toLowerCase()}: ${err.message}`, 'error')
      return false
    } finally {
      setBusy('')
    }
  }

  async function createIncident(form) {
    setBusy('create')
    try {
      const incident = await request('/api/incidents', { method: 'POST', body: JSON.stringify(form) })
      await loadIncidents()
      setDialog('')
      notify(`Incident ${incident.incident_id} created`)
      setPage('Incidents')
      await openIncident(incident)
    } catch (err) {
      notify(`Unable to create incident: ${err.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  async function submitAgentMessage(rawMessage, requestContext = agentContext) {
    const message = (rawMessage || '').trim()
    if (!message || busy === 'agent') return
    const activeContext = requestContext || {}
    setAgentMessages((items) => [...items, {
      id: `user-${Date.now()}`,
      role: 'user',
      type: 'text',
      text: message,
      createdAt: new Date().toISOString(),
    }])
    setAgentDraft('')
    setBusy('agent')

    try {
      const result = await request('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ message, context: activeContext, incident_id: activeContext.incident_id }),
      })
      const responseMessages = []
      if (result.message) responseMessages.push({ id: `assistant-${Date.now()}-text`, role: 'assistant', type: 'text', text: result.message })
      if (result.detected_incident && result.kind !== 'investigation') responseMessages.push({ id: `assistant-${Date.now()}-incident`, role: 'assistant', type: 'incident', incident: result.detected_incident })
      if (result.investigation) responseMessages.push({ id: `assistant-${Date.now()}-analysis`, role: 'assistant', type: 'analysis', investigation: result.investigation, incidentId: result.incident_id })
      if (result.incidents) responseMessages.push({ id: `assistant-${Date.now()}-list`, role: 'assistant', type: 'incident_list', incidents: result.incidents })

      if (result.kind === 'update_request' && result.incident_id) {
        await request(`/api/incidents/${encodeURIComponent(result.incident_id)}/actions`, {
          method: 'POST',
          body: JSON.stringify({ action: 'add_note', detail: result.detail || message }),
        })
        const updated = await request(`/api/incidents/${encodeURIComponent(result.incident_id)}`)
        await loadIncidents()
        responseMessages.push({ id: `assistant-${Date.now()}-updated`, role: 'assistant', type: 'updated', incident: updated })
        setAgentContext({})
        notify(`Incident ${updated.incident_id} updated`)
      } else if (result.kind === 'create_request' && result.candidate) {
        const incident = await request('/api/incidents', {
          method: 'POST',
          body: JSON.stringify({ ...result.candidate, status: 'INVESTIGATING' }),
        })
        await loadIncidents()
        responseMessages.push({ id: `assistant-${Date.now()}-created`, role: 'assistant', type: 'success', incident })
        setAgentContext({})
        notify(`Incident ${incident.incident_id} created`)
      } else {
        setAgentContext(result.context || activeContext)
        if (result.kind === 'investigation' && result.incident_id && result.detected_incident?.status !== 'RESOLVED') {
          try {
            await request(`/api/incidents/${encodeURIComponent(result.incident_id)}/actions`, {
              method: 'POST',
              body: JSON.stringify({ action: 'investigate', detail: 'Investigation requested through Sentinel Response Agent' }),
            })
            await loadIncidents()
          } catch (err) {
            notify(`Investigation completed, but the timeline could not be updated: ${err.message}`, 'error')
          }
        }
      }
      setAgentMessages((items) => [...items, ...responseMessages.map((item) => ({ ...item, createdAt: new Date().toISOString() }))])
    } catch (err) {
      setAgentMessages((items) => [...items, {
        id: `assistant-${Date.now()}-error`,
        role: 'assistant',
        type: 'error',
        text: `I couldn't complete that request. ${err.message}`,
        retryMessage: message,
        retryContext: activeContext,
        createdAt: new Date().toISOString(),
      }])
      notify(`Could not process the agent request: ${err.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  function askSentinel(incident) {
    const context = { incident_id: incident.incident_id }
    setPage('Agent')
    setSelected(null)
    setAgentContext(context)
    submitAgentMessage(`Investigate ${incident.incident_id}`, context)
  }

  function startNewConversation() {
    setAgentContext({})
    setAgentDraft('')
    setAgentMessages([{
      id: `welcome-${Date.now()}`,
      role: 'assistant',
      type: 'text',
      text: "Hello! I'm Sentinel, your Incident Response Agent. Describe the issue and I’ll help investigate it using Operations Memory.",
      createdAt: new Date().toISOString(),
    }])
  }

  async function generateRecommendation(incidentId) {
    setBusy('recommend')
    try {
      setRecommendation(await request(`/api/incidents/${encodeURIComponent(incidentId)}/recommend`, { method: 'POST' }))
    } catch (err) {
      notify(`Unable to load recommendations: ${err.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  async function generatePostmortem(incidentId) {
    setBusy('postmortem')
    try {
      const result = await request(`/api/incidents/${encodeURIComponent(incidentId)}/postmortem`, { method: 'POST' })
      setInvestigation({ incident_summary: result.incident_summary, recommended_actions: result.preventive_actions, postmortem: result })
      notify('Post-incident review generated')
    } catch (err) {
      notify(`Unable to generate review: ${err.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const filtered = incidents.filter((incident) => {
    const needle = query.trim().toLowerCase()
    const matchesQuery = !needle || [incident.incident_id, incident.title, incident.service, incident.symptoms]
      .some((value) => (value || '').toLowerCase().includes(needle))
    return matchesQuery && (severity === 'All severities' || incident.severity === severity)
      && (status === 'All statuses' || incident.status === status)
  }).sort((a, b) => sort === 'Oldest first'
    ? new Date(a.created_at || 0) - new Date(b.created_at || 0)
    : new Date(b.created_at || 0) - new Date(a.created_at || 0))

  const openCount = incidents.filter((item) => item.status !== 'RESOLVED').length
  const criticalCount = incidents.filter((item) => item.severity === 'SEV-1' && item.status !== 'RESOLVED').length
  const highCount = incidents.filter((item) => item.severity === 'SEV-2' && item.status !== 'RESOLVED').length
  const resolvedCount = incidents.filter((item) => item.status === 'RESOLVED').length
  const avgResponse = incidents.filter((item) => item.resolution_time > 0)
  const responseMinutes = avgResponse.length
    ? Math.round(avgResponse.reduce((sum, item) => sum + item.resolution_time, 0) / avgResponse.length)
    : null
  const chartData = buildChartData(incidents)

  const pageTitle = page === 'Overview' ? 'Security overview' : page === 'Incidents' ? 'Incident queue' : page === 'Agent' ? 'Response agent' : 'Operations memory'

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><span className="brand-mark"><Shield size={19} strokeWidth={2.4} /></span><span>SENTINEL<span className="brand-sub">INCIDENT RESPONSE</span></span><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={17} /></button></div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-switch"><span className="workspace-avatar">N</span><span><b>Northstar Systems</b><small>Production SOC</small></span><ChevronDown size={15} /></div>
        <div className="nav-label">OPERATIONS</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavButton label="Overview" active={page === 'Overview'} icon={<LayoutDashboard size={17} />} onClick={() => { setPage('Overview'); setMobileNav(false) }} />
          <NavButton label="Incidents" active={page === 'Incidents'} icon={<ShieldAlert size={17} />} count={openCount} onClick={() => { setPage('Incidents'); setMobileNav(false) }} />
          <NavButton label="Response agent" active={page === 'Agent'} icon={<Bot size={17} />} onClick={() => { setPage('Agent'); setMobileNav(false) }} />
          <NavButton label="Operations memory" active={page === 'Memory'} icon={<Command size={17} />} onClick={() => { setPage('Memory'); setMobileNav(false) }} />
        </nav>
        <div className="sidebar-lower">
          <div className="system-health"><span className={`health-dot ${health}`} /><span><b>API connection</b><small>{health === 'online' ? 'All systems operational' : health === 'checking' ? 'Checking connection' : 'Backend unavailable'}</small></span><span className={`health-label ${health}`}>{health === 'online' ? 'ONLINE' : health === 'checking' ? 'CHECK' : 'OFFLINE'}</span></div>
          <div className="sidebar-divider" />
          <div className="profile"><div className="profile-avatar">AM</div><span><b>Alex Morgan</b><small>Incident commander</small></span><button className="icon-button" title="Account settings" onClick={() => notify('Authentication is not enabled on this backend', 'info')}><ChevronDown size={15} /></button></div>
        </div>
      </aside>
      {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation overlay" />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Operations</span><ChevronRight size={14} /><b>{page}</b></div>
          <div className="topbar-actions"><div className="live-indicator"><span className="pulse-dot" />Polling every 15s</div><button className={`icon-button refresh-button ${refreshing ? 'spinning' : ''}`} title="Refresh incident data" onClick={() => loadIncidents()} disabled={refreshing}><RefreshCw size={16} /></button><button className="new-incident-button" onClick={() => setDialog('create')}><Plus size={16} /><span>New incident</span></button></div>
        </header>

        <div className="content-wrap">
          <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />SECURITY OPERATIONS CENTER</div><h1>{pageTitle}</h1><p>{page === 'Overview' ? 'Live visibility across your production environment.' : page === 'Incidents' ? 'Triage, investigate, and coordinate active response.' : page === 'Agent' ? 'Use incident context and historical memory to guide response.' : 'Search the patterns and lessons behind past incidents.'}</p></div><div className="heading-date"><span>MONITORING WINDOW</span><b><Activity size={14} /> Last 24 hours</b></div></div>

          {error && <div className="connection-banner"><AlertTriangle size={17} /><span><b>Could not reach the incident API.</b> {error} Check that the backend is running at {API}.</span><button onClick={() => loadIncidents()}><RefreshCw size={14} /> Retry</button></div>}

          {page === 'Overview' && <>
            <section className="metric-grid" aria-label="Incident metrics">
              <MetricCard label="Total incidents" value={loading ? '—' : incidents.length} icon={<Shield size={17} />} note="All reported events" tone="mint" />
              <MetricCard label="Critical · SEV-1" value={loading ? '—' : criticalCount} icon={<AlertOctagon size={17} />} note="Requires immediate action" tone="red" />
              <MetricCard label="High · SEV-2" value={loading ? '—' : highCount} icon={<AlertTriangle size={17} />} note="Priority response" tone="amber" />
              <MetricCard label="Active incidents" value={loading ? '—' : openCount} icon={<Activity size={17} />} note="Open or investigating" tone="blue" />
              <MetricCard label="Resolved" value={loading ? '—' : resolvedCount} icon={<CheckCircle2 size={17} />} note="Closed incidents" tone="green" />
              <MetricCard label="Avg. resolution" value={responseMinutes == null ? '—' : `${responseMinutes}m`} icon={<Clock3 size={17} />} note="Resolved incidents only" tone="violet" />
            </section>

            <section className="overview-grid">
              <div className="panel trend-panel"><div className="panel-heading"><div><h2>Incident activity</h2><p>Reported incidents by day</p></div><span className="chart-legend"><i /> Incidents</span></div><div className="chart-wrap">{loading ? <div className="chart-loading"><LoaderCircle className="spinning" size={20} /> Loading activity</div> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}><defs><linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#41c89c" stopOpacity={0.2} /><stop offset="95%" stopColor="#41c89c" stopOpacity={0} /></linearGradient></defs><CartesianGrid vertical={false} stroke="#e9eeeb" strokeDasharray="3 5" /><XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: '#8b9791', fontSize: 11, fontFamily: 'DM Mono' }} dy={10} /><YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#8b9791', fontSize: 11, fontFamily: 'DM Mono' }} /><Tooltip content={<ChartTooltip />} /><Area type="monotone" dataKey="incidents" stroke="#26a77c" strokeWidth={2.4} fill="url(#activityFill)" activeDot={{ r: 4, fill: '#26a77c', stroke: '#fff', strokeWidth: 2 }} /></AreaChart></ResponsiveContainer>}</div><div className="chart-footer"><span><span className="footer-dot" />Data from incident records</span><span>Refreshed automatically</span></div></div>
              <div className="panel distribution-panel"><div className="panel-heading"><div><h2>Severity distribution</h2><p>Current incident portfolio</p></div><button className="text-icon-button" onClick={() => setPage('Incidents')}>View queue <ArrowUpRight size={14} /></button></div><div className="severity-list">{SEVERITIES.map((level) => { const count = incidents.filter((item) => item.severity === level).length; const pct = incidents.length ? (count / incidents.length) * 100 : 0; return <div className="severity-row" key={level}><div className={`severity-mark ${severityTone(level)}`} /><span className="severity-name">{severityName(level)}</span><div className="severity-track"><span className={severityTone(level)} style={{ width: `${pct}%` }} /></div><span className="severity-number">{count}</span></div> })}</div><div className="status-summary"><span>STATUS BREAKDOWN</span><div>{STATUSES.map((item) => <div className="status-summary-row" key={item}><span className={`status-dot ${item.toLowerCase()}`} />{statusName(item)}<b>{incidents.filter((incident) => incident.status === item).length}</b></div>)}</div></div></div>
            </section>

            <section className="panel queue-panel"><div className="panel-heading queue-heading"><div><h2>Priority queue</h2><p>Incidents requiring attention</p></div><button className="text-icon-button" onClick={() => setPage('Incidents')}>All incidents <ArrowUpRight size={14} /></button></div><IncidentTable incidents={filtered.filter((item) => item.status !== 'RESOLVED').slice(0, 5)} loading={loading} onOpen={openIncident} emptyText="No active incidents. Your queue is clear." /></section>
            <footer className="dashboard-footer"><span><ShieldCheck size={15} /> Incident response status</span><span className={`footer-status ${health}`}><i />{health === 'online' ? 'Connected to backend' : health === 'checking' ? 'Checking backend' : 'Backend disconnected'}</span><span className="footer-time">Polling at 15 second intervals</span></footer>
          </>}

          {page === 'Incidents' && <section className="panel incident-list-panel"><div className="list-toolbar"><div className="list-title"><h2>All incidents <span>{incidents.length}</span></h2><p>Search and filter the incident register</p></div><button className="new-incident-button compact" onClick={() => setDialog('create')}><Plus size={15} />Create incident</button></div><div className="filter-row"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, service, or description" /><kbd>⌘ K</kbd></label><div className="select-wrap"><Filter size={15} /><select aria-label="Filter by severity" value={severity} onChange={(event) => setSeverity(event.target.value)}><option>All severities</option>{SEVERITIES.map((item) => <option key={item} value={item}>{severityName(item)}</option>)}</select><ChevronDown size={13} /></div><div className="select-wrap"><ListFilter size={15} /><select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}><option>All statuses</option>{STATUSES.map((item) => <option key={item} value={item}>{statusName(item)}</option>)}</select><ChevronDown size={13} /></div><div className="select-wrap sort-select"><SlidersHorizontal size={15} /><select aria-label="Sort incidents" value={sort} onChange={(event) => setSort(event.target.value)}><option>Newest first</option><option>Oldest first</option></select><ChevronDown size={13} /></div></div><IncidentTable incidents={filtered} loading={loading} onOpen={openIncident} emptyText={incidents.length ? 'No incidents match these filters.' : 'No incidents have been reported yet.'} /><div className="list-footnote">Showing <b>{filtered.length}</b> of <b>{incidents.length}</b> incidents <span>Refresh interval · 15s</span></div></section>}

          {page === 'Agent' && <ChatAgentPage incidents={incidents} health={health} busy={busy} messages={agentMessages} draft={agentDraft} setDraft={setAgentDraft} onSend={submitAgentMessage} onNewConversation={startNewConversation} onOpen={openIncident} onInvestigateIncident={(incident) => submitAgentMessage(`Investigate ${incident.incident_id}`, { incident_id: incident.incident_id })} />}

          {page === 'Memory' && <MemoryPage incidents={incidents} onOpen={openIncident} />}
        </div>
      </main>

      {selected && <IncidentDrawer incident={selected} events={events} investigation={investigation} recommendation={recommendation} busy={busy} onClose={() => setSelected(null)} onAction={performAction} onInvestigate={runInvestigation} onAskSentinel={askSentinel} onRecommend={generateRecommendation} onPostmortem={generatePostmortem} onAssign={() => setDialog('assign')} onNote={() => setDialog('note')} notify={notify} />}
      {selected && <button className="drawer-ask-sentinel" onClick={() => askSentinel(selected)}><MessageSquare size={15} />Ask Sentinel</button>}
      {dialog === 'create' && <CreateDialog busy={busy === 'create'} onClose={() => setDialog('')} onSubmit={createIncident} />}
      {dialog === 'assign' && selected && <ActionDialog type="assign" busy={busy === 'assign'} onClose={() => setDialog('')} onSubmit={async (value) => { const done = await performAction(selected.incident_id, 'assign', '', true, value); if (done) setDialog('') }} />}
      {dialog === 'note' && selected && <ActionDialog type="add_note" busy={busy === 'add_note'} onClose={() => setDialog('')} onSubmit={async (value) => { const done = await performAction(selected.incident_id, 'add_note', value); if (done) setDialog('') }} />}
      <div className="toast-stack" aria-live="polite">{notifications.map((item) => <div className={`toast ${item.type}`} key={item.id}><span className="toast-icon">{item.type === 'error' ? <AlertTriangle size={16} /> : item.type === 'info' ? <CircleHelp size={16} /> : <Check size={16} />}</span><span>{item.message}</span><button aria-label="Dismiss notification" onClick={() => setNotifications((items) => items.filter((toast) => toast.id !== item.id))}><X size={14} /></button></div>)}</div>
    </div>
  )
}

function NavButton({ label, icon, active, count, onClick }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{count > 0 && <b>{count}</b>}</button>
}

function MetricCard({ label, value, icon, note, tone }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-value">{value}</div><div className="metric-note"><span className={`metric-indicator ${tone}`} />{note}</div></article>
}

function IncidentTable({ incidents, loading, onOpen, emptyText }) {
  return <div className="table-scroll"><table className="incident-table"><thead><tr><th>INCIDENT</th><th>SEVERITY</th><th>SERVICE</th><th>STATUS</th><th>DETECTED</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan="6"><div className="table-state"><LoaderCircle size={17} className="spinning" /> Loading incidents from backend...</div></td></tr> : incidents.length ? incidents.map((incident) => <tr key={incident.incident_id} onClick={() => onOpen(incident)} tabIndex="0" onKeyDown={(event) => event.key === 'Enter' && onOpen(incident)}><td><div className="incident-id">{incident.incident_id}</div><div className="incident-title">{incident.title}</div></td><td><SeverityBadge value={incident.severity} /></td><td><span className="service-cell"><span className="service-avatar">{(incident.service || '?').slice(0, 1).toUpperCase()}</span>{incident.service}</span></td><td><StatusBadge value={incident.status} /></td><td className="time-cell">{formatTime(incident.created_at)}</td><td><button className="row-arrow" aria-label={`Open ${incident.incident_id}`}><ChevronRight size={16} /></button></td></tr>) : <tr><td colSpan="6"><div className="empty-state"><span className="empty-icon"><ShieldCheck size={23} /></span><b>{emptyText}</b><span>Incident data is loaded directly from the response API.</span></div></td></tr>}</tbody></table></div>
}

function SeverityBadge({ value = '' }) {
  return <span className={`severity-badge ${severityTone(value)}`}><i />{severityName(value)}</span>
}

function StatusBadge({ value = '' }) {
  return <span className={`status-badge ${value.toLowerCase()}`}><i />{statusName(value)}</span>
}

function AgentPage({ incidents, onCreate, onOpen, onAnalyze, busy }) {
  const active = incidents.filter((item) => item.status !== 'RESOLVED').slice(0, 4)
  return <div className="agent-page-grid"><section className="panel agent-intro"><div className="agent-orbit"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><span><Bot size={31} /></span><i className="orbit-node node-one" /><i className="orbit-node node-two" /><i className="orbit-node node-three" /></div><div className="eyebrow"><span className="eyebrow-line" />INCIDENT RESPONSE AGENT</div><h2>Context-aware incident analysis</h2><p>Investigate an incident with the configured analysis service and surface relevant historical cases from the operations memory.</p><div className="agent-capabilities"><span><Sparkles size={14} />LLM-assisted analysis</span><span><Command size={14} />Historical incident recall</span><span><ShieldCheck size={14} />Evidence-led recommendations</span></div><button className="new-incident-button" onClick={onCreate}><Plus size={15} />Submit an incident</button></section><section className="panel agent-worklist"><div className="panel-heading"><div><h2>Choose an incident</h2><p>Analysis uses current incident and event context</p></div><span className="worklist-count">{active.length} active</span></div>{active.length ? <div className="agent-incident-list">{active.map((incident) => <div className="agent-incident" key={incident.incident_id}><button className="agent-incident-main" onClick={() => onOpen(incident)}><SeverityBadge value={incident.severity} /><b>{incident.title}</b><span>{incident.incident_id} · {incident.service}</span></button><button className="analyze-button" disabled={!!busy} onClick={() => onAnalyze(incident.incident_id)}>{busy === 'investigate' ? <LoaderCircle className="spinning" size={14} /> : <Zap size={14} />}Analyze</button></div>)}</div> : <div className="empty-state compact-empty"><span className="empty-icon"><ShieldCheck size={23} /></span><b>No active incidents to analyze</b><span>Submit an incident to start an investigation.</span></div>}<div className="agent-foot"><span className="health-dot" />Results are generated by the configured backend agent.</div></section><section className="agent-note"><div className="note-icon"><Gauge size={18} /></div><div><b>Analysis availability</b><p>The backend may use an external LLM when configured, or its built-in rule-based fallback. Results include confidence and historical matches when available.</p></div></section></div>
}

function ChatAgentPage({ incidents, health, busy, messages, draft, setDraft, onSend, onNewConversation, onOpen, onInvestigateIncident }) {
  const active = incidents.filter((item) => item.status !== 'RESOLVED').slice(0, 4)
  const chatRef = useRef(null)
  const quickActions = [
    { label: 'Report an Incident', prompt: 'Report an incident' },
    { label: 'Investigate an Existing Incident', prompt: 'Investigate an existing incident' },
    { label: 'Find Similar Incidents', prompt: 'Find similar incidents' },
    { label: 'Check Active Incidents', prompt: 'Check active incidents' },
  ]

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages, busy])

  function submit(event) {
    event.preventDefault()
    if (draft.trim()) onSend(draft)
  }

  return <section className="panel agent-chat-panel">
    <header className="agent-chat-header">
      <div className="agent-chat-title-wrap"><div className="agent-chat-avatar"><Bot size={19} /></div><div>
        <div className="agent-title-row"><h2>Sentinel Response Agent</h2><span className={`agent-status-dot ${health}`}><i />{health === 'online' ? 'Online' : health === 'checking' ? 'Connecting' : 'Offline'}</span></div>
        <p>AI-powered incident investigation and response</p>
      </div></div>
      <button className="icon-button agent-new-chat" title="Start a new conversation" aria-label="Start a new conversation" onClick={onNewConversation}><RotateCcw size={15} /></button>
    </header>

    <div className="agent-quick-actions">{quickActions.map((action) => <button key={action.label} type="button" className="quick-action" disabled={!!busy} onClick={() => onSend(action.prompt)}>{action.label}</button>)}</div>

    <div className="agent-chat-body" ref={chatRef} aria-live="polite">
      {messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}>
        <div className="chat-avatar">{message.role === 'assistant' ? <Bot size={15} /> : <UserRound size={14} />}</div>
        <div className="chat-message-content"><div className="chat-message-meta"><b>{message.role === 'assistant' ? 'Sentinel' : 'You'}</b><time>{message.createdAt ? formatTime(message.createdAt) : 'Now'}</time></div>
          <div className={`chat-bubble ${message.type || 'text'}`}>
            {message.type === 'incident' && message.incident ? <>
              <div className="chat-card-heading"><ShieldAlert size={15} />Detected incident</div>
              <div className="agent-detail-grid"><DetailItem label="SERVICE" value={message.incident.service || 'Not identified'} /><DetailItem label="ENVIRONMENT" value={message.incident.environment || 'Not identified'} /><DetailItem label="EVIDENCE" value={message.incident.error_logs || message.incident.evidence || 'Not provided'} /><DetailItem label="SUGGESTED SEVERITY" value={`${severityName(message.incident.severity)}${message.incident.severity_reason ? ` · ${message.incident.severity_reason}` : ''}`} /></div>
              <div className="chat-card-actions"><button className="action-primary" disabled={!!busy} onClick={() => onSend('Yes, investigate')}>Investigate</button></div>
            </> : message.type === 'analysis' && message.investigation ? <>
              <div className="chat-card-heading"><Activity size={15} />Investigation summary</div><p className="chat-analysis-summary">{message.investigation.summary}</p>
              <div className="investigation-sections">
                <div><span>Possible root cause</span><b>{(message.investigation.possible_root_causes || []).join('; ') || 'No root cause identified from available evidence.'}</b></div>
                <div><span>Evidence</span><b>{(message.investigation.evidence || []).map((item) => item.detail).filter(Boolean).join(' ') || 'Reviewed the report and stored incident records.'}</b></div>
                <div><span>Similar incidents</span><b>{message.investigation.similar_incidents?.length ? message.investigation.similar_incidents.map((item) => item.incident_id).join(', ') : 'No similar incident was found in Operations Memory.'}</b></div>
                <div><span>Previous resolution</span><b>{message.investigation.previous_resolution || 'No previous resolution is recorded.'}</b></div>
                <div><span>Recommended runbook</span><b>{message.investigation.recommended_runbook || 'No runbook is recorded for these matches.'}</b></div>
                {message.investigation.confidence != null && <div><span>Confidence</span><b>{Math.round(message.investigation.confidence * 100)}% · estimate, not confirmation</b></div>}
              </div>
                {message.incidentId ? <p className="chat-confirmed-context">Investigation is for {message.incidentId}; no new incident was created.</p> : message.investigation.active_incident ? <div className="chat-card-actions"><button className="action-primary" disabled={!!busy} onClick={() => onSend('Update existing incident')}>Update {message.investigation.active_incident.incident_id}</button><button className="action-secondary" disabled={!!busy} onClick={() => onSend('Create separate incident')}>Create separate incident</button><span>Sentinel found an active record for this service.</span></div> : <div className="chat-card-actions"><button className="action-primary" disabled={!!busy} onClick={() => onSend('Create incident')}>Create Incident</button><span>Creates a record only after your confirmation.</span></div>}
            </> : (message.type === 'success' || message.type === 'updated') && message.incident ? <>
              <div className="success-pill"><Check size={13} />{message.type === 'updated' ? 'Existing incident updated' : 'Incident created'}</div>
              <div className="created-meta"><strong>Incident ID:</strong> {message.incident.incident_id}</div><div className="created-meta"><strong>Service:</strong> {message.incident.service}</div><div className="created-meta"><strong>Severity:</strong> {severityName(message.incident.severity)}</div><div className="created-meta"><strong>Environment:</strong> {message.incident.environment}</div><div className="created-meta"><strong>Status:</strong> {statusName(message.incident.status)}</div>
              {message.type === 'updated' && <div className="created-meta">Your report was added to the existing response timeline.</div>}
              <button className="text-icon-button" onClick={() => onOpen(message.incident)}>View Incident <ArrowUpRight size={14} /></button>
            </> : message.type === 'incident_list' ? <>
              <p>{message.text}</p>{message.incidents.length ? message.incidents.map((incident) => <button className="agent-list-item" key={incident.incident_id} disabled={!!busy} onClick={() => onInvestigateIncident(incident)}><SeverityBadge value={incident.severity} /><span><b>{incident.title}</b><small>{incident.incident_id} · {incident.service} · {statusName(incident.status)}</small></span><ChevronRight size={15} /></button>) : <p>No active incidents are currently recorded.</p>}
            </> : <><p>{message.text}</p>{message.type === 'error' && <button className="retry-button" disabled={!!busy} onClick={() => onSend(message.retryMessage, message.retryContext)}><RotateCcw size={13} />Retry</button>}</>}
          </div>
        </div>
      </article>)}
      {busy === 'agent' && <article className="chat-message assistant"><div className="chat-avatar"><Bot size={15} /></div><div className="chat-message-content"><div className="chat-message-meta"><b>Sentinel</b><time>Now</time></div><div className="chat-bubble typing-bubble"><LoaderCircle size={14} className="spinning" />Checking incident records and Operations Memory…</div></div></article>}
    </div>

    <form className="agent-chat-input" onSubmit={submit}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(event) } }} placeholder="Describe your incident…" rows={2} disabled={!!busy} aria-label="Message Sentinel" /><button type="submit" className="send-button" disabled={!draft.trim() || !!busy}><Send size={15} />Send</button><span className="agent-input-hint">Enter to send · Shift+Enter for a new line</span></form>

    <aside className="agent-context-panel"><div className="agent-context-header">Active incidents <span>{active.length}</span></div>{active.length ? active.map((incident) => <button className="context-item" key={incident.incident_id} onClick={() => onInvestigateIncident(incident)} disabled={!!busy}><span className="context-id">{incident.incident_id}</span><span className="context-title">{incident.title}</span><ChevronRight size={14} /></button>) : <div className="compact-empty">No active incidents</div>}</aside>
  </section>
}

function MemoryPage({ incidents, onOpen }) {
  const [search, setSearch] = useState('')
  const matches = incidents.filter((item) => [item.title, item.service, item.symptoms, item.root_cause, item.lessons_learned].some((field) => (field || '').toLowerCase().includes(search.toLowerCase())))
  return <section className="panel memory-panel"><div className="memory-header"><div className="memory-emblem"><Command size={21} /></div><div><div className="eyebrow"><span className="eyebrow-line" />HISTORICAL CONTEXT</div><h2>Operations memory</h2><p>Search past incident records, causes, and resolution notes from the connected backend.</p></div></div><label className="memory-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search incidents, services, symptoms, root causes..." /><span>{matches.length} records</span></label><div className="memory-results">{matches.map((incident) => <button className="memory-record" key={incident.incident_id} onClick={() => onOpen(incident)}><div className="memory-record-top"><span className="incident-id">{incident.incident_id}</span><SeverityBadge value={incident.severity} /></div><b>{incident.title}</b><span className="memory-service">{incident.service} · {formatTime(incident.created_at)}</span><p>{incident.root_cause || incident.symptoms || 'No investigation notes have been recorded.'}</p><span className="memory-open">Open incident <ArrowUpRight size={13} /></span></button>)}{!matches.length && <div className="empty-state"><span className="empty-icon"><Search size={22} /></span><b>{incidents.length ? 'No matching memories' : 'No stored incident records'}</b><span>Memory is derived from incidents persisted by the API.</span></div>}</div></section>
}

function IncidentDrawer({ incident, events, investigation, recommendation, busy, onClose, onAction, onInvestigate, onRecommend, onPostmortem, onAssign, onNote, notify }) {
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveText, setResolveText] = useState('')
  const [postmortem, setPostmortem] = useState(null)
  const actions = events.length ? events : []
  async function resolveIncident() {
    if (resolveText.trim().length < 5) return
    const done = await onAction(incident.incident_id, 'resolve', resolveText.trim())
    if (done) setResolveOpen(false)
  }
  async function showPostmortem() {
    await onPostmortem(incident.incident_id)
  }
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="incident-drawer" aria-label="Incident details"><div className="drawer-topbar"><span><ShieldAlert size={16} /> INCIDENT DETAIL</span><button className="icon-button" onClick={onClose} aria-label="Close incident details"><X size={19} /></button></div><div className="drawer-body"><div className="drawer-title-block"><div className="drawer-title-id"><span className="incident-id">{incident.incident_id}</span><span className="detected-label">DETECTED {formatDateTime(incident.created_at)}</span></div><h2>{incident.title}</h2><div className="drawer-badges"><SeverityBadge value={incident.severity} /><StatusBadge value={incident.status} /></div></div><div className="detail-grid"><DetailItem label="SERVICE" value={incident.service} /><DetailItem label="ENVIRONMENT" value={incident.environment || 'production'} /><DetailItem label="AFFECTED SYSTEM" value={incident.affected_components || 'Not specified'} /><DetailItem label="DEPLOYMENT" value={incident.deployment_version || 'Not specified'} /></div><section className="drawer-section"><SectionHeading icon={<FileText size={15} />} title="Incident overview" /><p className="detail-copy">{incident.symptoms || 'No incident description provided.'}</p>{incident.error_logs && <pre className="log-block">{incident.error_logs}</pre>}</section><section className="drawer-section"><SectionHeading icon={<Activity size={15} />} title="Response timeline" /><div className="timeline"><TimelineItem title="Incident detected" detail={`${incident.service} · ${severityName(incident.severity)}`} time={incident.created_at} state="done" />{actions.map((event) => <TimelineItem key={event.id} title={actionLabel(event.event_type)} detail={event.detail || 'Action recorded'} time={event.created_at} state="done" />)}{incident.status === 'RESOLVED' ? <TimelineItem title="Incident resolved" detail={incident.resolution || 'Resolution recorded'} time={incident.resolved_at || incident.created_at} state="done" last /> : <TimelineItem title={incident.status === 'INVESTIGATING' ? 'Under investigation' : incident.status === 'CONTAINED' ? 'Contained' : 'Awaiting response'} detail={incident.status === 'OPEN' ? 'Response team has not started triage' : 'Current incident status'} state="current" last />}</div></section>{incident.root_cause && <section className="drawer-section"><SectionHeading icon={<Search size={15} />} title="Root cause" /><p className="detail-copy">{incident.root_cause}</p></section>}{investigation && <section className="drawer-section analysis-result"><SectionHeading icon={<Sparkles size={15} />} title={investigation.postmortem ? 'Post-incident review' : 'Agent analysis'} />{investigation.postmortem ? <div className="analysis-summary">{investigation.postmortem.impact}<p>{investigation.postmortem.root_cause}</p></div> : <><p className="analysis-summary">{investigation.incident_summary}</p><div className="confidence-line"><span>Analysis confidence</span><b>{Math.round((investigation.confidence || 0) * 100)}%</b></div>{investigation.possible_root_causes?.map((cause) => <div className="analysis-bullet" key={cause}><span />{cause}</div>)}<div className="recommendation-block"><b>Suggested runbook</b><span>{investigation.recommended_runbook}</span></div>{investigation.recommended_actions?.map((action) => <div className="analysis-bullet" key={action}><span />{action}</div>)}</>}</section>}{recommendation && <section className="drawer-section analysis-result"><SectionHeading icon={<Sparkles size={15} />} title="Recommended response" /><p className="analysis-summary">{recommendation.recommendation}</p><p className="detail-copy">{recommendation.why}</p><div className="recommendation-block"><b>{recommendation.recommended_runbook || 'Runbook'}</b><span>{recommendation.expected_benefit}</span></div>{recommendation.warning && <p className="warning-copy"><AlertTriangle size={14} />{recommendation.warning}</p>}</section>}</div><div className="drawer-actions"><div className="action-row"><button className="action-secondary" disabled={!!busy} onClick={() => onInvestigate(incident.incident_id)}>{busy === 'investigate' ? <LoaderCircle className="spinning" size={15} /> : <Search size={15} />}Investigate</button><button className="action-secondary" disabled={!!busy} onClick={() => onRecommend(incident.incident_id)}>{busy === 'recommend' ? <LoaderCircle className="spinning" size={15} /> : <Sparkles size={15} />}Recommend</button><button className="action-icon" title="Assign responder" onClick={onAssign}><MessageSquare size={15} /></button><button className="action-icon" title="Add a note" onClick={onNote}><FileText size={15} /></button></div><div className="action-row primary-actions">{incident.status === 'OPEN' && <button className="action-primary" disabled={!!busy} onClick={() => onAction(incident.incident_id, 'start_response', 'Response initiated by SOC operator')}><Zap size={15} />Start response</button>}{incident.status !== 'RESOLVED' && incident.status !== 'CONTAINED' && <button className="action-secondary" disabled={!!busy} onClick={() => onAction(incident.incident_id, 'contain', 'Incident marked as contained')}><ShieldCheck size={15} />Contain</button>}{incident.status !== 'RESOLVED' && <button className="action-secondary resolve-action" onClick={() => setResolveOpen((value) => !value)}><CheckCircle2 size={15} />Resolve</button>}<button className="action-secondary" disabled={!!busy} onClick={() => onAction(incident.incident_id, 'escalate', 'Escalated for additional review')}><ArrowUpRight size={15} />Escalate</button><button className="action-secondary" disabled={!!busy} onClick={showPostmortem}>{busy === 'postmortem' ? <LoaderCircle className="spinning" size={15} /> : <FileText size={15} />}Review</button></div>{resolveOpen && <div className="resolve-form"><label htmlFor="resolveText">Resolution summary</label><textarea id="resolveText" value={resolveText} onChange={(event) => setResolveText(event.target.value)} placeholder="Describe the resolution..." minLength="5" required /><div><button className="action-secondary" onClick={() => setResolveOpen(false)}>Cancel</button><button className="action-primary" disabled={resolveText.trim().length < 5 || !!busy} onClick={resolveIncident}>Confirm resolution</button></div></div>}</div></aside></div>
}

function CreateDialog({ busy, onClose, onSubmit }) {
  const [form, setForm] = useState({ title: '', service: '', severity: 'SEV-2', symptoms: '', error_logs: '', environment: 'production', affected_components: '', deployment_version: '' })
  const [errors, setErrors] = useState({})
  function update(event) { setForm((value) => ({ ...value, [event.target.name]: event.target.value })); setErrors((value) => ({ ...value, [event.target.name]: '' })) }
  function submit(event) {
    event.preventDefault()
    const next = {}
    if (form.title.trim().length < 3) next.title = 'Enter at least 3 characters.'
    if (form.service.trim().length < 2) next.service = 'Enter a service name.'
    if (form.symptoms.trim().length < 5) next.symptoms = 'Add at least 5 characters of incident context.'
    if (form.error_logs.trim().length < 5) next.error_logs = 'Add log or alert evidence (at least 5 characters).'
    setErrors(next)
    if (!Object.keys(next).length) onSubmit(form)
  }
  return <Modal title="Report an incident" subtitle="Create a record in the connected incident register." onClose={onClose}><form className="incident-form" onSubmit={submit} noValidate><div className="form-grid"><FormField label="Incident title" error={errors.title} wide><input name="title" value={form.title} onChange={update} placeholder="e.g. Elevated 5xx errors on payment API" /></FormField><FormField label="Affected service" error={errors.service}><input name="service" value={form.service} onChange={update} placeholder="payments-api" /></FormField><FormField label="Severity"><select name="severity" value={form.severity} onChange={update}>{SEVERITIES.map((item) => <option key={item} value={item}>{severityName(item)}</option>)}</select></FormField><FormField label="Incident description" error={errors.symptoms} wide><textarea name="symptoms" value={form.symptoms} onChange={update} placeholder="Describe what users or monitoring are reporting..." rows="3" /></FormField><FormField label="Alert / log evidence" error={errors.error_logs} wide><textarea name="error_logs" value={form.error_logs} onChange={update} placeholder="Paste relevant log lines, alert details, or event context..." rows="3" /></FormField><FormField label="Environment"><select name="environment" value={form.environment} onChange={update}><option value="production">Production</option><option value="staging">Staging</option><option value="development">Development</option></select></FormField><FormField label="Affected components"><input name="affected_components" value={form.affected_components} onChange={update} placeholder="Optional" /></FormField><FormField label="Deployment version"><input name="deployment_version" value={form.deployment_version} onChange={update} placeholder="Optional" /></FormField></div><div className="modal-actions"><button type="button" className="action-secondary" onClick={onClose}>Cancel</button><button className="action-primary" disabled={busy}>{busy ? <><LoaderCircle size={15} className="spinning" />Creating...</> : <><Plus size={15} />Create incident</>}</button></div></form></Modal>
}

function ActionDialog({ type, busy, onClose, onSubmit }) {
  const [value, setValue] = useState('')
  const assign = type === 'assign'
  const valid = assign ? value.trim().length >= 2 : value.trim().length >= 2
  return <Modal title={assign ? 'Assign responder' : 'Add incident note'} subtitle={assign ? 'Record the responder responsible for this incident.' : 'Add a note to the incident response timeline.'} onClose={onClose}><form className="incident-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(value.trim()) }}><label className="field-label">{assign ? 'Responder name or team' : 'Note'}{assign ? <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="e.g. Alex Morgan / Platform on-call" /> : <textarea autoFocus rows="4" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter an operational update..." />}</label><div className="modal-actions"><button type="button" className="action-secondary" onClick={onClose}>Cancel</button><button className="action-primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spinning" size={15} /> : assign ? <Check size={15} /> : <Send size={15} />}{busy ? 'Saving...' : assign ? 'Assign responder' : 'Add note'}</button></div></form></Modal>
}

function Modal({ title, subtitle, children, onClose }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>
}

function FormField({ label, error, wide, children }) {
  return <label className={`field-label ${wide ? 'field-wide' : ''}`}>{label}{children}{error && <span className="field-error">{error}</span>}</label>
}

function DetailItem({ label, value }) { return <div className="detail-item"><span>{label}</span><b>{value}</b></div> }
function SectionHeading({ icon, title }) { return <h3 className="section-heading">{icon}{title}</h3> }
function TimelineItem({ title, detail, time, state, last }) { return <div className={`timeline-item ${state} ${last ? 'last' : ''}`}><span className="timeline-node">{state === 'done' ? <Check size={11} /> : <i />}</span><div className="timeline-content"><div><b>{title}</b><time>{time ? formatDateTime(time) : 'In progress'}</time></div><p>{detail}</p></div></div> }
function ChartTooltip({ active, payload, label }) { if (!active || !payload?.length) return null; return <div className="chart-tooltip"><span>{label}</span><b>{payload[0].value} incident{payload[0].value === 1 ? '' : 's'}</b></div> }

function buildChartData(incidents) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date()
    day.setDate(day.getDate() - (6 - index))
    day.setHours(0, 0, 0, 0)
    return { date: day, day: day.toLocaleDateString('en-US', { weekday: 'short' }), incidents: 0 }
  })
  incidents.forEach((incident) => {
    const date = new Date(incident.created_at || '')
    const bucket = days.find((item) => item.date.toDateString() === date.toDateString())
    if (bucket) bucket.incidents += 1
  })
  return days
}

function actionLabel(action = '') {
  return ({ investigate: 'Investigation started', start_response: 'Response started', assign: 'Responder assigned', contain: 'Incident contained', resolve: 'Incident resolved', add_note: 'Note added', escalate: 'Incident escalated' })[action] || action.replaceAll('_', ' ')
}
function severityName(value = '') { return ({ 'SEV-1': 'Critical', 'SEV-2': 'High', 'SEV-3': 'Medium', 'SEV-4': 'Low' })[value] || value || 'Unknown' }
function severityTone(value = '') { return ({ 'SEV-1': 'critical', 'SEV-2': 'high', 'SEV-3': 'medium', 'SEV-4': 'low' })[value] || 'low' }
function statusName(value = '') { return ({ OPEN: 'Open', INVESTIGATING: 'Investigating', CONTAINED: 'Contained', RESOLVED: 'Resolved' })[value] || value || 'Unknown' }
function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
function formatDateTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }

export default App