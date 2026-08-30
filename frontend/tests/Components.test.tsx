import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EmptyLibraryState } from "@/components/library/EmptyLibraryState";

describe("EmptyLibraryState", () => {
  it("explains how to add books", () => {
    render(<EmptyLibraryState />);
    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByText(/Point tuxbooks at a folder of EPUB files/i)).toBeInTheDocument();
  });
});
