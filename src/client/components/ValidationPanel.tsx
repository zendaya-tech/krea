import { ChevronDown, ChevronUp, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useEditorStore } from "../stores/editorStore";

export function ValidationPanel() {
  const issues = useEditorStore((s) => s.issues);
  const [collapsed, setCollapsed] = useState(true);

  if (issues.length === 0) return null;

  return (
    <div className={`validation-panel ${collapsed ? "collapsed" : ""}`}>
      <button className="validation-header" onClick={() => setCollapsed((c) => !c)}>
        <TriangleAlert size={14} />
        {issues.length} validation issue{issues.length > 1 ? "s" : ""}
        {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {!collapsed && (
        <ul className="validation-list">
          {issues.map((issue, i) => (
            <li key={i} className={`validation-item severity-${issue.severity}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
