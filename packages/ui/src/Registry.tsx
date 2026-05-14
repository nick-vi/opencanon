import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, FolderGit2 } from "lucide-react";
import { fetchRegistryProjects } from "./api.ts";
import { InlineState, PaneBody, PaneButton, PaneHeader, PaneSubtitle, PaneTitle, StatusTag } from "./components/ui.tsx";
import type { ProjectSummary } from "./types.ts";

const registryCellClassName = "mono";

type Props = {
  onOpenProject: (project: ProjectSummary) => void;
  onBack: () => void;
};

export function Registry({ onOpenProject, onBack }: Props) {
  const query = useQuery({ queryKey: ["registry"], queryFn: fetchRegistryProjects });
  const projects = query.data ?? [];

  return (
    <section className="registryView" aria-label="Project switcher">
      <PaneHeader>
        <PaneButton inline onClick={onBack} title="Back to workbench" aria-label="Back to workbench">
          <ArrowLeft size={13} />
        </PaneButton>
        <PaneTitle>Project switcher</PaneTitle>
        <PaneSubtitle>running daemons / {projects.length} registered</PaneSubtitle>
      </PaneHeader>
      <PaneBody scroll>
        {query.isLoading ? <InlineState>Loading daemons...</InlineState> : null}
        {query.isError ? <InlineState tone="error">{(query.error as Error).message}</InlineState> : null}
        {query.data && projects.length === 0 ? (
          <InlineState>No daemons registered. Start a daemon in another repo to switch between projects.</InlineState>
        ) : null}
        {projects.length > 0 ? (
          <table className="registryTable">
            <thead>
              <tr>
                <th>Root</th>
                <th>Status</th>
                <th>URL</th>
                <th>PID</th>
                <th>Canon</th>
                <th>Findings</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id} onClick={() => onOpenProject(project)} tabIndex={0}>
                  <td>
                    <div className="registryRoot">
                      <FolderGit2 size={13} />
                      <span>{project.rootDir}</span>
                    </div>
                  </td>
                  <td>
                    <StatusTag status={project.status} />
                  </td>
                  <td className={registryCellClassName}>{project.url || "n/a"}</td>
                  <td className={registryCellClassName}>{project.pid ?? "n/a"}</td>
                  <td className={registryCellClassName}>{project.files ?? "n/a"}</td>
                  <td className={registryCellClassName}>{project.findings ?? "n/a"}</td>
                  <td><ArrowRight size={14} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </PaneBody>
    </section>
  );
}
