import { useEffect, useState } from 'react';
import { GameLayoutCanvas } from './GameLayoutCanvas';
import { GameLayoutSidebar } from './GameLayoutSidebar';
import { GameLayoutTray } from './GameLayoutTray';
import { useLayoutView } from './useLayoutView';
import { useGameLayoutStore } from '../../stores/useGameLayoutStore';
import styles from './GameLayout.module.css';

/** The in-game layout editor: tile canvas, tools tray and sidebar. */
export function GameLayoutView() {
  const model = useLayoutView();
  const notice = useGameLayoutStore((s) => s.notice);

  return (
    <div className={styles.view}>
      <GameLayoutCanvas view={model.view} doc={model.doc} />
      {model.ctx.problem.instances.length === 0 && (
        <div className={styles.empty}>
          <p>There are no machines yet.</p>
          <p>Add recipes in the Flowchart view, then place them here or press Generate.</p>
        </div>
      )}
      <GameLayoutSidebar model={model} />
      <GameLayoutTray model={model} />
      {notice && <Notice key={notice.id} text={notice.text} tone={notice.tone} />}
    </div>
  );
}

/** Short status message that hides itself after a few seconds. */
function Notice({ text, tone }: { text: string; tone: 'info' | 'error' | 'success' }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div className={styles.notice} data-tone={tone} role="status">
      {text}
    </div>
  );
}
