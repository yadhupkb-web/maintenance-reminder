import { useState } from 'react';

function AddAdvancedTaskForm({ onAdd }) {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    intervalValue: '',
    intervalType: 'days',
    time: '09:00',
    startDate: '',
    advanceWarningDays: '',
    nagIntervalValue: '1',
    nagIntervalType: 'hours',
  });

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.intervalValue) return;

    onAdd({
      taskType: 'advanced',
      name: form.name.trim(),
      phone: form.phone.trim(),
      intervalValue: parseInt(form.intervalValue, 10),
      intervalType: form.intervalType,
      time: form.intervalType === 'days' ? form.time : undefined,
      startDate: form.intervalType === 'days' && form.startDate ? form.startDate : undefined,
      advanceWarningDays: form.advanceWarningDays ? parseInt(form.advanceWarningDays, 10) : 0,
      nagIntervalValue: parseInt(form.nagIntervalValue, 10) || 1,
      nagIntervalType: form.nagIntervalType,
    });

    setForm({ 
      name: '', phone: '', intervalValue: '', intervalType: 'days', 
      time: '09:00', startDate: '', advanceWarningDays: '', 
      nagIntervalValue: '1', nagIntervalType: 'hours' 
    });
  };

  const handleTest = async (e) => {
    e.preventDefault();
    if (!form.phone.trim()) {
      alert("Please enter a phone number or group name first.");
      return;
    }
    
    const API_URL = import.meta.env.DEV ? 'http://localhost:3001' : '';
    try {
      const res = await fetch(`${API_URL}/api/test-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: form.phone.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        alert("Test message sent successfully!");
      } else {
        alert("Error: " + data.error);
      }
    } catch (err) {
      alert("Failed to send test message: " + err.message);
    }
  };

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="adv-task-name">Task</label>
        <input
          id="adv-task-name"
          type="text"
          name="name"
          placeholder="What needs to be done?"
          value={form.name}
          onChange={handleChange}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="adv-task-phone">Phone number or Group Invite Link</label>
        <input
          id="adv-task-phone"
          type="text"
          name="phone"
          placeholder="+91... or https://chat.whatsapp.com/..."
          value={form.phone}
          onChange={handleChange}
          required
        />
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="adv-task-interval">Repeat Every</label>
          <input
            id="adv-task-interval"
            type="number"
            name="intervalValue"
            placeholder="e.g. 1"
            min="1"
            value={form.intervalValue}
            onChange={handleChange}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="adv-task-interval-type">Unit</label>
          <select
            id="adv-task-interval-type"
            name="intervalType"
            value={form.intervalType}
            onChange={handleChange}
          >
            <option value="days">Days</option>
            <option value="minutes">Minutes (testing)</option>
          </select>
        </div>
      </div>

      {form.intervalType === 'days' && (
        <div className="form-row">
          <div className="field">
            <label htmlFor="adv-task-start-date">Next Due Date</label>
            <input
              id="adv-task-start-date"
              type="date"
              name="startDate"
              value={form.startDate}
              onChange={handleChange}
            />
          </div>
          <div className="field">
            <label htmlFor="adv-task-time">Due Time</label>
            <input
              id="adv-task-time"
              type="time"
              name="time"
              value={form.time}
              onChange={handleChange}
            />
          </div>
        </div>
      )}

      <div className="form-row">
        <div className="field">
          <label htmlFor="adv-warning">Advance Warning (Days before due)</label>
          <input
            id="adv-warning"
            type="number"
            name="advanceWarningDays"
            placeholder="e.g. 3"
            min="1"
            value={form.advanceWarningDays}
            onChange={handleChange}
          />
          <small style={{display: 'block', marginTop: '4px', color: '#888'}}>Sends 1 daily reminder leading up to due date</small>
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="adv-nag">If Overdue, Nag Me Every:</label>
          <select
            id="adv-nag"
            name="nagIntervalValue"
            value={form.nagIntervalValue}
            onChange={(e) => {
              const val = e.target.value;
              let type = 'hours';
              if (val === '24') { type = 'days'; }
              setForm(prev => ({ ...prev, nagIntervalValue: val, nagIntervalType: type }));
            }}
          >
            <option value="1">1 Hour</option>
            <option value="12">12 Hours</option>
            <option value="24">1 Day</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
        <button type="submit" className="btn-add">Add Advanced Task</button>
        <button type="button" className="btn-add" style={{ backgroundColor: '#6c757d' }} onClick={handleTest}>Send Test Message</button>
      </div>
    </form>
  );
}

export default AddAdvancedTaskForm;
