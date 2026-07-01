import { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import AddTaskForm from './components/AddTaskForm';
import AddAdvancedTaskForm from './components/AddAdvancedTaskForm';
import TaskList from './components/TaskList';
import StatusBar from './components/StatusBar';
import './App.css';

const API_URL = import.meta.env.DEV ? 'http://localhost:3001' : '';
const socket = io(API_URL || undefined);

function App() {
  const [status, setStatus] = useState('disconnected');
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [toast, setToast] = useState(null);
  const [activeTab, setActiveTab] = useState('reminders');

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/api/tasks`)
      .then((r) => r.json())
      .then((data) => setTasks(data.tasks))
      .catch(() => {});

    fetch(`${API_URL}/api/logs`)
      .then((r) => r.json())
      .then((data) => setLogs(data.logs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    socket.on('status', (s) => setStatus(s));
    socket.on('log', (entry) => {
      setLogs((prev) => [...prev.slice(-99), entry]);
    });
    socket.on('tasks_updated', (updatedTasks) => {
      setTasks(updatedTasks);
    });

    return () => {
      socket.off('status');
      socket.off('log');
      socket.off('tasks_updated');
    };
  }, []);

  const handleAddTask = async (taskData) => {
    try {
      const res = await fetch(`${API_URL}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`"${data.task.name}" added`);
      } else {
        showToast(data.error || 'Failed to add task', 'error');
      }
    } catch {
      showToast('Server not reachable', 'error');
    }
  };

  const handleDeleteTask = async (id) => {
    try {
      const res = await fetch(`${API_URL}/api/tasks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Task removed');
      }
    } catch {
      showToast('Failed to remove', 'error');
    }
  };

  const statusLabel = {
    ready: 'Connected',
    disconnected: 'Disconnected — scan QR in terminal',
    qr: 'Waiting for QR scan in terminal…',
  };

  const dotClass = {
    ready: 'connected',
    disconnected: 'disconnected',
    qr: 'waiting',
  };

  const activeTasks = tasks.filter(t => 
    activeTab === 'reminders' ? t.taskType !== 'advanced' : t.taskType === 'advanced'
  );

  return (
    <div className="app">
      <header className="header">
        <h1>{activeTab === 'reminders' ? 'Reminders' : 'Advanced Tasks'}</h1>
        <p>WhatsApp task reminders on autopilot</p>
        <div className="tabs">
          <button 
            className={`tab ${activeTab === 'reminders' ? 'active' : ''}`}
            onClick={() => setActiveTab('reminders')}
          >
            Standard Reminders
          </button>
          <button 
            className={`tab ${activeTab === 'advanced' ? 'active' : ''}`}
            onClick={() => setActiveTab('advanced')}
          >
            Daily / Advanced
          </button>
        </div>
      </header>

      <div className="connection">
        <span className={`connection-dot ${dotClass[status] || 'disconnected'}`} />
        {statusLabel[status] || 'Disconnected'}
      </div>

      <div className="section">
        <div className="section-title">New {activeTab === 'reminders' ? 'Reminder' : 'Advanced Task'}</div>
        {activeTab === 'reminders' ? (
          <AddTaskForm onAdd={handleAddTask} />
        ) : (
          <AddAdvancedTaskForm onAdd={handleAddTask} />
        )}
      </div>

      <div className="section">
        <div className="section-title">Active {activeTab === 'reminders' ? 'Reminders' : 'Tasks'} ({activeTasks.length})</div>
        <TaskList tasks={activeTasks} onDelete={handleDeleteTask} />
      </div>

      <div className="section">
        <div className="section-title">Activity</div>
        <StatusBar logs={logs} />
      </div>

      {toast && (
        <div className={`toast ${toast.type}`}>{toast.message}</div>
      )}
    </div>
  );
}

export default App;
