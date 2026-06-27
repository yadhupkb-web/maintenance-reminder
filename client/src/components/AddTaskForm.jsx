import { useState } from 'react';

function AddTaskForm({ onAdd }) {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    intervalValue: '',
    intervalType: 'days',
    time: '09:00',
    startDate: '',
  });

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.intervalValue) return;

    onAdd({
      name: form.name.trim(),
      phone: form.phone.trim(),
      intervalValue: parseInt(form.intervalValue, 10),
      intervalType: form.intervalType,
      time: form.intervalType === 'days' ? form.time : undefined,
      startDate: form.intervalType === 'days' && form.startDate ? form.startDate : undefined,
    });

    setForm({ name: '', phone: '', intervalValue: '', intervalType: 'days', time: '09:00', startDate: '' });
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

  // Get today's date in YYYY-MM-DD for the min attribute
  const today = new Date().toISOString().split('T')[0];

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="task-name">Task</label>
        <input
          id="task-name"
          type="text"
          name="name"
          placeholder="What needs to be done?"
          value={form.name}
          onChange={handleChange}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="task-phone">Phone number or Group Invite Link</label>
        <input
          id="task-phone"
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
          <label htmlFor="task-interval">Every</label>
          <input
            id="task-interval"
            type="number"
            name="intervalValue"
            placeholder="e.g. 3"
            min="1"
            value={form.intervalValue}
            onChange={handleChange}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="task-interval-type">Unit</label>
          <select
            id="task-interval-type"
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
            <label htmlFor="task-start-date">Start date</label>
            <input
              id="task-start-date"
              type="date"
              name="startDate"
              value={form.startDate}
              onChange={handleChange}
            />
          </div>
          <div className="field">
            <label htmlFor="task-time">At time</label>
            <input
              id="task-time"
              type="time"
              name="time"
              value={form.time}
              onChange={handleChange}
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px' }}>
        <button type="submit" className="btn-add">Add reminder</button>
        <button type="button" className="btn-add" style={{ backgroundColor: '#6c757d' }} onClick={handleTest}>Send Test Message</button>
      </div>
    </form>
  );
}

export default AddTaskForm;
