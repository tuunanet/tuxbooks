import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PdfPageField } from "@/components/reader/pdf/PdfPageField";

function renderField(overrides: { pageNumber?: number; pageCount?: number } = {}) {
  const onSetPage = vi.fn();
  const view = render(
    <PdfPageField
      pageNumber={overrides.pageNumber ?? 1}
      pageCount={overrides.pageCount ?? 3}
      onSetPage={onSetPage}
    />,
  );
  const input = screen.getByTestId("pdf-page-input") as HTMLInputElement;
  const rerender = (pageNumber: number) =>
    view.rerender(
      <PdfPageField
        pageNumber={pageNumber}
        pageCount={overrides.pageCount ?? 3}
        onSetPage={onSetPage}
      />,
    );
  return { onSetPage, input, rerender };
}

describe("PdfPageField", () => {
  it("commits exactly once when Enter is pressed", async () => {
    const { onSetPage, input } = renderField();

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "2{Enter}");

    expect(onSetPage).toHaveBeenCalledTimes(1);
    expect(onSetPage).toHaveBeenCalledWith(2);
  });

  it("commits exactly once on blur", async () => {
    const { onSetPage, input } = renderField();

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.tab();

    expect(onSetPage).toHaveBeenCalledTimes(1);
    expect(onSetPage).toHaveBeenCalledWith(2);
  });

  it("does not commit on Escape", async () => {
    const { onSetPage, input } = renderField();

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "3{Escape}");

    expect(onSetPage).not.toHaveBeenCalled();
  });

  it("tracks an external page change while focused and unedited", async () => {
    const { onSetPage, input, rerender } = renderField({ pageNumber: 1 });

    act(() => {
      input.focus();
    });
    expect(input).toHaveValue("1");

    rerender(2);
    await waitFor(() => expect(input).toHaveValue("2"));

    fireEvent.blur(input);
    expect(onSetPage).not.toHaveBeenCalled();
  });

  it("keeps the user's draft across an external page change", async () => {
    const { input, rerender } = renderField({ pageNumber: 1 });

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "3");

    rerender(2);

    expect(input).toHaveValue("3");
  });

  it("ignores the wheel while the field is not focused", () => {
    const { onSetPage, input } = renderField();

    fireEvent.wheel(input, { deltaY: 100 });

    expect(onSetPage).not.toHaveBeenCalled();
  });

  it("steps one page on a full wheel tick while focused", () => {
    const { onSetPage, input } = renderField();
    act(() => {
      input.focus();
    });

    fireEvent.wheel(input, { deltaY: 100 });

    expect(onSetPage).toHaveBeenCalledTimes(1);
    expect(onSetPage).toHaveBeenCalledWith(2);
  });

  it("steps once when a burst of micro ticks crosses the threshold", () => {
    const { onSetPage, input } = renderField();
    act(() => {
      input.focus();
    });

    for (let tick = 0; tick < 5; tick += 1) {
      fireEvent.wheel(input, { deltaY: 5 });
    }

    expect(onSetPage).toHaveBeenCalledTimes(1);
    expect(onSetPage).toHaveBeenCalledWith(2);
  });

  it("clears the accumulator across an idle gap so micro ticks do not sum", () => {
    vi.useFakeTimers();
    try {
      const { onSetPage, input } = renderField();
      act(() => {
        input.focus();
      });

      fireEvent.wheel(input, { deltaY: 5 });
      vi.advanceTimersByTime(500);
      fireEvent.wheel(input, { deltaY: 5 });

      expect(onSetPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps with the Up and Down arrows while focused", () => {
    const { onSetPage, input } = renderField({ pageNumber: 2 });
    act(() => {
      input.focus();
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(onSetPage).toHaveBeenNthCalledWith(1, 3);
    expect(onSetPage).toHaveBeenNthCalledWith(2, 1);
  });
});
