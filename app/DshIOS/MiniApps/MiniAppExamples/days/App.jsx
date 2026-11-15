import { useEffect, useMemo, useState } from 'react';
import './style.css';
import { locale, t, unit } from './i18n.js';

const KEY = 'days.v1';
const COLORS = ['#2F5BEA', '#E2483D', '#C9790A', '#1E9E6A', '#8B5CF6', '#0E8A96'];
const ICONS = ['🎂', '🎆', '✈️', '💍', '🎓', '🏠', '🌸', '🐟', '❤️', '🎄', '🏃', '📦'];
const DAY = 86400000;

const today = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};
const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parse = (text) => {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/// The day it counts to: for a yearly date, the next one from today on.
function target(event) {
  const date = parse(event.date);
  if (!event.yearly) return date;
  const now = today();
  const next = new Date(now.getFullYear(), date.getMonth(), date.getDate());
  return next < now ? new Date(now.getFullYear() + 1, date.getMonth(), date.getDate()) : next;
}

/// Days from today: positive ahead, negative behind.
const offset = (event) => Math.round((target(event) - today()) / DAY);

const longDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const shortDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });

function seed() {
  const now = today();
  return [
    { id: 'new-year', title: t.seedNewYear, date: `${now.getFullYear()}-01-01`, yearly: true, icon: '🎆', color: COLORS[0], pinned: true },
    { id: 'spring', title: t.seedSpring, date: `${now.getFullYear()}-03-20`, yearly: true, icon: '🌸', color: COLORS[4], pinned: false },
    { id: 'start', title: t.seedStart, date: iso(now), yearly: false, icon: '🐟', color: COLORS[3], pinned: false },
  ];
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved)) return saved;
  } catch {}
  return seed();
}

export default function App() {
  const [events, setEvents] = useState(load);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(events));
  }, [events]);

  // Ahead soonest first, then behind most recent first.
  const sorted = useMemo(() => {
    return [...events].sort((a, b) => {
      const x = offset(a), y = offset(b);
      if ((x >= 0) !== (y >= 0)) return x >= 0 ? -1 : 1;
      return Math.abs(x) - Math.abs(y);
    });
  }, [events]);
  const hero = sorted.find((event) => event.pinned) || sorted[0];
  const rest = sorted.filter((event) => event !== hero);

  const save = (event) => {
    setEvents((list) => {
      const others = list.map((item) => (event.pinned ? { ...item, pinned: false } : item)).filter((item) => item.id !== event.id);
      return [...others, event];
    });
    setEditing(null);
  };
  const remove = (id) => {
    setEvents((list) => list.filter((item) => item.id !== id));
    setEditing(null);
  };

  return (
    <main className="page">
      {hero ? <Ticket event={hero} onOpen={() => setEditing(hero)} /> : <p className="empty">{t.empty}</p>}

      {rest.length > 0 && (
        <ul className="list">
          {rest.map((event) => (
            <li key={event.id}>
              <Row event={event} onOpen={() => setEditing(event)} />
            </li>
          ))}
        </ul>
      )}

      <button className="add" onClick={() => setEditing({})}>
        <span aria-hidden="true">＋</span> {t.add}
      </button>

      {editing && <Editor event={editing} onSave={save} onRemove={remove} onClose={() => setEditing(null)} />}
    </main>
  );
}

/// The date in front: a ticket, its count above the perforation and the day itself on the stub.
function Ticket({ event, onOpen }) {
  const days = offset(event);
  return (
    <button className="ticket" style={{ '--tone': event.color }} onClick={onOpen}>
      <div className="ticket-top">
        <span className="ticket-title">
          <span className="ticket-icon" aria-hidden="true">{event.icon}</span>
          {event.title}
        </span>
        {days === 0 ? (
          <span className="ticket-today">{t.today}</span>
        ) : (
          <span className="ticket-count">
            <span className="ticket-lead">{days > 0 ? t.future : t.past}</span>
            <span className="ticket-number">{Math.abs(days)}</span>
            <span className="ticket-unit">{unit(Math.abs(days))}</span>
          </span>
        )}
      </div>
      <div className="ticket-stub">
        <span>{longDate.format(target(event))}</span>
        {event.yearly && <span className="ticket-yearly">{t.yearly}</span>}
      </div>
    </button>
  );
}

function Row({ event, onOpen }) {
  const days = offset(event);
  return (
    <button className="row" onClick={onOpen}>
      <span className="row-icon" style={{ background: `${event.color}1f` }} aria-hidden="true">{event.icon}</span>
      <span className="row-text">
        <span className="row-title">{event.title}</span>
        <span className="row-date">
          {shortDate.format(target(event))}
          {event.yearly && <span className="row-yearly" style={{ color: event.color }}>{t.yearly}</span>}
        </span>
      </span>
      {days === 0 ? (
        <span className="row-today" style={{ color: event.color }}>{t.todayShort}</span>
      ) : (
        <span className="row-count">
          <span className="row-number" style={{ color: event.color }}>{Math.abs(days)}</span>
          <span className="row-rel">{t.rel(Math.abs(days), days > 0)}</span>
        </span>
      )}
    </button>
  );
}

function Editor({ event, onSave, onRemove, onClose }) {
  const isNew = !event.id;
  const [title, setTitle] = useState(event.title || '');
  const [date, setDate] = useState(event.date || iso(today()));
  const [yearly, setYearly] = useState(event.yearly || false);
  const [pinned, setPinned] = useState(event.pinned || false);
  const [icon, setIcon] = useState(event.icon || ICONS[0]);
  const [color, setColor] = useState(event.color || COLORS[0]);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const valid = title.trim() && date;
  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSave({ id: event.id || String(Date.now()), title: title.trim(), date, yearly, pinned, icon, color });
  };

  return (
    <div className={`sheet-backdrop${shown ? ' shown' : ''}`} onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="sheet-bar">
          <button type="button" className="link" onClick={onClose}>{t.cancel}</button>
          <strong>{isNew ? t.newTitle : t.editTitle}</strong>
          <button type="submit" className="link strong" disabled={!valid}>{t.save}</button>
        </header>

        <div className="preview" style={{ '--tone': color }} aria-hidden="true">
          <span>{icon}</span>
        </div>

        <div className="group">
          <label className="field">
            <span>{t.name}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t.namePlaceholder} maxLength={30} />
          </label>
          <label className="field">
            <span>{t.date}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>

        <div className="group">
          <label className="toggle">
            <span>
              {t.repeat}
              <small>{t.repeatHint}</small>
            </span>
            <input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
          </label>
          <label className="toggle">
            <span>{t.pin}</span>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          </label>
        </div>

        <p className="caption">{t.icon}</p>
        <div className="icons">
          {ICONS.map((choice) => (
            <button type="button" key={choice} className={choice === icon ? 'picked' : ''} onClick={() => setIcon(choice)}>{choice}</button>
          ))}
        </div>

        <p className="caption">{t.color}</p>
        <div className="colors">
          {COLORS.map((choice) => (
            <button type="button" key={choice} aria-label={choice} className={choice === color ? 'picked' : ''} style={{ background: choice }} onClick={() => setColor(choice)} />
          ))}
        </div>

        {!isNew && (
          <button type="button" className="remove" onClick={() => onRemove(event.id)}>{t.remove}</button>
        )}
      </form>
    </div>
  );
}
