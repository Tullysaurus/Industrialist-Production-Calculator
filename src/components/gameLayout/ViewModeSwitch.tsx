import { Factory, Workflow } from 'lucide-react';
import { useUIStore, type ViewMode } from '../../stores/useUIStore';
import styles from './GameLayout.module.css';

const MODES: { id: ViewMode; label: string; Icon: typeof Factory; title: string }[] = [
  { id: 'flowchart', label: 'Flowchart', Icon: Workflow, title: 'Plan production as a flowchart' },
  {
    id: 'ingame',
    label: 'In-game layout',
    Icon: Factory,
    title: 'Lay the factory out tile by tile',
  },
];

/** Switch between the planner flowchart and the in-game layout editor. */
export function ViewModeSwitch() {
  const mode = useUIStore((s) => s.viewMode);
  const setMode = useUIStore((s) => s.setViewMode);
  return (
    <div className={styles['mode-switch']} role="tablist" aria-label="View">
      {MODES.map(({ id, label, Icon, title }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          data-active={mode === id ? 'true' : 'false'}
          className={styles['mode-button']}
          onClick={() => setMode(id)}
          title={title}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
