import { ChevronDown, LayoutGrid, List, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FORMAT_FILTER_OPTIONS, formatFilterLabel, toggleFormatFilter } from "@/lib/formats";
import { pickBookFiles, pickDirectory } from "@/lib/bridge";
import { useImport } from "@/state/importState";
import type { BookFormat } from "@/types/domain";
import { BOOK_SORT_OPTIONS, type BookSortId, type BookViewMode } from "./sections";

interface LibraryHeaderProps {
  title: string;
  count: number;
  query: string;
  onQueryChange: (query: string) => void;
  formats: readonly BookFormat[];
  onFormatsChange: (formats: BookFormat[]) => void;
  sort: BookSortId;
  onSortChange: (sort: BookSortId) => void;
  view: BookViewMode;
  onViewChange: (view: BookViewMode) => void;
}

export function LibraryHeader({
  title,
  count,
  query,
  onQueryChange,
  formats,
  onFormatsChange,
  sort,
  onSortChange,
  view,
  onViewChange,
}: LibraryHeaderProps) {
  const { importPaths } = useImport();

  const importFolder = async () => {
    const dir = await pickDirectory();
    if (dir) await importPaths([dir]);
  };

  const importFiles = async () => {
    const files = await pickBookFiles();
    if (files.length > 0) await importPaths(files);
  };

  const toggleFormat = (id: BookFormat, checked: boolean) => {
    onFormatsChange(toggleFormatFilter(formats, id, checked));
  };

  return (
    <header
      data-testid="library-header"
      className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
    >
      <div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p data-testid="library-stats" className="text-sm text-muted-foreground">
          {count} {count === 1 ? "book" : "books"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            data-testid="library-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search"
            aria-label="Search books"
            className="w-44 pl-8"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-testid="library-format-filter"
              aria-label={`Format filter: ${formatFilterLabel(formats)}`}
              variant="outline"
              size="sm"
            >
              {formatFilterLabel(formats)}
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              data-testid="format-filter-all"
              disabled={formats.length === 0}
              onSelect={() => onFormatsChange([])}
            >
              All formats
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {FORMAT_FILTER_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                data-testid={`format-filter-${option.id}`}
                checked={formats.includes(option.id)}
                // Ticking several formats is the point; keep the menu open.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => toggleFormat(option.id, checked)}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Select value={sort} onValueChange={(value) => onSortChange(value as BookSortId)}>
          <SelectTrigger
            data-testid="library-sort"
            aria-label="Sort books"
            size="sm"
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BOOK_SORT_OPTIONS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="import-menu" size="sm">
              <Plus data-icon="inline-start" />
              Import
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="import-files" onSelect={() => void importFiles()}>
              Import Files…
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="import-folder" onSelect={() => void importFolder()}>
              Import Folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={view}
          onValueChange={(value) => {
            // Radix emits "" when the active item is clicked; keep a mode selected.
            if (value) onViewChange(value as BookViewMode);
          }}
          aria-label="View mode"
        >
          <ToggleGroupItem value="grid" aria-label="Grid view" title="Grid view">
            <LayoutGrid />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view" title="List view">
            <List />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </header>
  );
}
