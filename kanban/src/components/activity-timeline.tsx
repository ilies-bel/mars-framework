"use client";

import { cn } from "@/lib/utils";
import type { Bead, Comment } from "@/types";

export interface ActivityTimelineProps {
  bead: Bead;
  comments: Comment[];
  childBeads?: Bead[];
}

/**
 * Timeline event types
 */
type TimelineEventType = "created" | "status_change" | "comment" | "branch" | "child_created" | "child_status_change";

interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  description: string;
  timestamp: Date;
}

/**
 * Format a date for display (e.g., "Jan 12, 10:57 AM")
 */
function formatTimestamp(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  }) + ", " + date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Truncate a string to maxLength characters with ellipsis
 */
function truncateTitle(title: string, maxLength: number = 30): string {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength - 1) + "\u2026";
}

/**
 * Build timeline events from bead and comments
 */
function buildTimelineEvents(bead: Bead, comments: Comment[], childBeads: Bead[] = []): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Created event
  const createdAt = new Date(bead.created_at);
  events.push({
    id: `created-${bead.id}`,
    type: "created",
    description: "Created",
    timestamp: createdAt,
  });

  // Status change event (if updated_at differs from created_at)
  const updatedAt = new Date(bead.updated_at);
  if (updatedAt.getTime() !== createdAt.getTime()) {
    events.push({
      id: `status-${bead.id}`,
      type: "status_change",
      description: `Status \u2192 ${bead.status}`,
      timestamp: updatedAt,
    });
  }

  // Comment events
  comments.forEach((comment) => {
    events.push({
      id: `comment-${comment.id}`,
      type: "comment",
      description: "Comment added",
      timestamp: new Date(comment.created_at),
    });
  });

  // Child task events
  childBeads.forEach((child) => {
    const childCreatedAt = new Date(child.created_at);
    const childUpdatedAt = new Date(child.updated_at);
    const truncatedTitle = truncateTitle(child.title);

    // Child created event
    events.push({
      id: `child-created-${child.id}`,
      type: "child_created",
      description: `Task created: ${truncatedTitle}`,
      timestamp: childCreatedAt,
    });

    // Child status change event (if updated_at differs from created_at)
    if (childUpdatedAt.getTime() !== childCreatedAt.getTime()) {
      events.push({
        id: `child-status-${child.id}`,
        type: "child_status_change",
        description: `Task \u2192 ${child.status}: ${truncatedTitle}`,
        timestamp: childUpdatedAt,
      });
    }
  });

  // Sort chronologically (oldest first)
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return events;
}

/**
 * Activity Timeline component
 * Displays a vertical timeline of bead activity events
 */
export function ActivityTimeline({ bead, comments, childBeads = [] }: ActivityTimelineProps) {
  const events = buildTimelineEvents(bead, comments, childBeads);

  if (events.length === 0) {
    return (
      <div className="mt-6 text-sm text-muted-foreground">
        No activity recorded
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-1">
      <h4 className="text-sm font-semibold text-foreground mb-3">
        Activity Timeline
      </h4>
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[5px] top-2 bottom-2 w-px bg-zinc-700" />

        {/* Events */}
        <div className="space-y-3">
          {events.map((event, index) => (
            <div
              key={event.id}
              className="relative flex items-start gap-3 pl-5"
            >
              {/* Dot */}
              <div
                className={cn(
                  "absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full border-2 bg-background",
                  event.type === "created" && "border-green-500",
                  event.type === "status_change" && "border-blue-500",
                  event.type === "comment" && "border-zinc-400",
                  event.type === "branch" && "border-purple-500",
                  event.type === "child_created" && "border-cyan-500",
                  event.type === "child_status_change" && "border-cyan-400"
                )}
              />

              {/* Content */}
              <div className="flex flex-1 items-center justify-between min-w-0">
                <span className="text-xs text-zinc-400 truncate">
                  {event.description}
                </span>
                <span className="text-[10px] text-zinc-600 whitespace-nowrap ml-2">
                  {formatTimestamp(event.timestamp)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
