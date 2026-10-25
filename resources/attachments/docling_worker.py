"""Isolated, offline Docling conversion with bounded page and context coverage.

The parent owns cancellation and publication. This process writes document.md,
document.json and up to two PDF page images into its private output directory.
Office output represents native document structure and source page provenance.
"""

import argparse
import contextlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import re
import sys
from xml.etree import ElementTree
from zipfile import ZipFile

DOCLING_VERSION = "2.142.1"
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
TEXT_CHARACTERS = 200_000


class PreparationError(Exception):
    pass


def install_offline_policy(runtime: Path) -> None:
    os.environ.update({
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HOME": str(runtime / "cache" / "huggingface"),
        "DOCLING_ARTIFACTS_PATH": str(runtime / "models"),
        "OMP_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "OPENBLAS_NUM_THREADS": "2",
        "TOKENIZERS_PARALLELISM": "false",
        "TQDM_DISABLE": "1",
    })

    def audit(event, _args):
        if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
            raise PreparationError("Offline conversion requires local artifacts. " + models_help(runtime))

    sys.addaudithook(audit)


def models_help(runtime: Path) -> str:
    return (
        "Provision the local layout/table/OCR models with npm run setup:attachments "
        "or node scripts/setup-attachments.mjs --directory "
        + json.dumps(str(runtime)) + " --models-only."
    )


def read_xml(archive: ZipFile, name: str):
    if archive.getinfo(name).file_size > MAX_XML_BYTES:
        raise PreparationError("The Office XML part exceeds 16 MiB. Split the document into smaller files.")
    content = archive.read(name)
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise PreparationError("Save the Office document with self-contained XML parts and attach it again.")
    return ElementTree.fromstring(content)


def office_coverage(source: Path, suffix: str) -> tuple[int | None, str]:
    with ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 10_000 or sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
            raise PreparationError("The expanded Office document exceeds the 128 MiB / 10,000-part budget. Split it into smaller files.")
        if suffix == ".pptx":
            root = read_xml(archive, "ppt/presentation.xml")
            return len(root.findall(".//{*}sldId")), "slides"
        if suffix == ".xlsx":
            root = read_xml(archive, "xl/workbook.xml")
            # Bound native table expansion, including sparse sheets with very large dimensions.
            cells = 0
            for entry in entries:
                if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", entry.filename):
                    sheet = read_xml(archive, entry.filename)
                    cells += sum(1 for _ in sheet.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"))
                    dimension = sheet.find("{*}dimension")
                    if dimension is not None:
                        match = re.fullmatch(r"[A-Z]+\d+:([A-Z]+)(\d+)", dimension.get("ref", ""))
                        if match:
                            column = 0
                            for letter in match[1]:
                                column = column * 26 + ord(letter) - ord("A") + 1
                            if column * int(match[2]) > 100_000:
                                raise PreparationError("A worksheet exceeds the 100,000-cell extent budget. Split the worksheet into smaller files.")
            if cells > 100_000:
                raise PreparationError("The workbook exceeds the 100,000-cell budget. Split the workbook into smaller files.")
            return len(root.findall(".//{*}sheet")), "worksheets"
        root = read_xml(archive, "word/document.xml")
        body = root.find("{*}body")
        if body is not None and len(body) > 20_000:
            raise PreparationError("The Word document exceeds the 20,000-block budget. Split it into smaller files.")
        return None, "native document structure"


def pdf_previews(pdf, output: Path, converted_pages: list[int]) -> list[dict]:
    images = []
    for number in converted_pages[:2]:
        page = pdf[number - 1]
        try:
            width, height = page.get_size()
            if width <= 0 or height <= 0:
                raise PreparationError(f"PDF page {number} has invalid dimensions.")
            bitmap = page.render(scale=min(1.5, 1600 / max(width, height)))
            try:
                image = bitmap.to_pil()
                try:
                    file_name = f"page-{number}.jpg"
                    image.convert("RGB").save(output / file_name, "JPEG", quality=85)
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()
        images.append({"fileName": file_name, "mediaType": "image/jpeg", "label": f"PDF page {number}"})
    return images


def convert(source: Path, output: Path, runtime: Path, max_pages: int, suffix: str) -> dict:
    if sys.version_info[:2] != (3, 12):
        raise PreparationError("The attachment worker uses Python 3.12. Run npm run setup:attachments to prepare its isolated environment.")
    try:
        version = importlib.metadata.version("docling-slim")
    except importlib.metadata.PackageNotFoundError as error:
        raise PreparationError("Docling is missing from the isolated environment. Run npm run setup:attachments.") from error
    if version != DOCLING_VERSION:
        raise PreparationError(f"The attachment worker requires Docling {DOCLING_VERSION}; found {version}. Run npm run setup:attachments.")
    if not source.is_file() or source.stat().st_size > MAX_FILE_BYTES:
        raise PreparationError("Choose a regular document within the 64 MiB conversion budget.")

    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.backend_options import ThreadedDoclingParseBackendOptions
    from docling.datamodel.base_models import ConversionStatus, InputFormat
    from docling.datamodel.pipeline_options import ConvertPipelineOptions, PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import (
        DocumentConverter, ExcelFormatOption, PdfFormatOption, PowerpointFormatOption, WordFormatOption,
    )

    formats = {".pdf": InputFormat.PDF, ".docx": InputFormat.DOCX, ".pptx": InputFormat.PPTX, ".xlsx": InputFormat.XLSX}
    if suffix not in formats:
        raise PreparationError("Choose a PDF, DOCX, PPTX or XLSX document.")
    pdf = None
    try:
        if suffix == ".pdf":
            import pypdfium2
            pdf = pypdfium2.PdfDocument(source)
            total, unit = len(pdf), "PDF pages"
            models = runtime / "models"
            if not models.is_dir() or not any(models.iterdir()):
                raise PreparationError("Local PDF models are missing. " + models_help(runtime))
        else:
            total, unit = office_coverage(source, suffix)
        if total is not None and total < 1:
            raise PreparationError("The document contains zero convertible pages, slides or worksheets.")

        accelerator = AcceleratorOptions(num_threads=2, device=AcceleratorDevice.CPU)
        common = dict(artifacts_path=runtime / "models", document_timeout=150,
                      enable_remote_services=False, allow_external_plugins=False,
                      accelerator_options=accelerator)
        pdf_options = PdfPipelineOptions(**common, do_ocr=True, do_table_structure=True,
                                         ocr_options=RapidOcrOptions(backend="onnxruntime", lang=["ch"]),
                                         generate_page_images=False, generate_picture_images=False)
        native_options = ConvertPipelineOptions(**common)
        converter = DocumentConverter(allowed_formats=[formats[suffix]], format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options,
                backend_options=ThreadedDoclingParseBackendOptions(parser_threads=2, max_concurrent_results=2)),
            InputFormat.DOCX: WordFormatOption(pipeline_options=native_options),
            InputFormat.PPTX: PowerpointFormatOption(pipeline_options=native_options),
            InputFormat.XLSX: ExcelFormatOption(pipeline_options=native_options),
        })
        # page_range selects a bounded prefix while preserving the original source page numbers.
        result = converter.convert(source, raises_on_error=False, max_file_size=MAX_FILE_BYTES,
                                   page_range=(1, min(total, max_pages) if total else max_pages))
        if result.status not in {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}:
            details = "; ".join(str(error.error_message) for error in result.errors)
            raise PreparationError(f"Docling conversion failed: {details[:2000]}. " + models_help(runtime))
        document = result.document
        pages = sorted(int(number) for number in document.pages)
        # Successful page results distinguish an empty page from a failed page.
        if suffix == ".pdf":
            successful = sorted(page.page_no + 1 for page in result.pages
                                if page.status == ConversionStatus.SUCCESS) if result.pages and hasattr(result.pages[0], "status") else pages
        else:
            successful = pages
        expected = list(range(1, min(total, max_pages) + 1)) if total else []
        missing = [number for number in expected if number not in successful]
        partial = result.status == ConversionStatus.PARTIAL_SUCCESS or bool(missing)
        page_truncated = total is not None and total > max_pages
        if total is None:
            coverage_text = "Coverage: native Word document structure. Source pagination follows the DOCX structure; visual page layout requires an Office renderer."
            markdown = document.export_to_markdown()
        else:
            coverage_text = f"Coverage: {unit} {', '.join(map(str, successful)) or 'none'} of {total}; conversion limit {max_pages}."
            if suffix != ".pdf":
                coverage_text += " Office coverage follows native slide/worksheet structure; visual layout requires an Office renderer."
            markdown = "\n\n".join(f"## Source {unit}: {number}\n\n{document.export_to_markdown(page_no=number)}" for number in successful)
        if partial:
            coverage_text += f" Conversion status: partial; missing source units: {missing}."
        images = pdf_previews(pdf, output, successful) if pdf is not None else []
        coverage_text += f" Preview coverage: {len(images)} PDF page images." if pdf is not None else " Preview coverage: native structure and source provenance."
        text_truncated = len(markdown) > TEXT_CHARACTERS
        if text_truncated:
            coverage_text += f" Prepared text covers the first {TEXT_CHARACTERS} characters; document.md and document.json contain the complete converted range."
        else:
            coverage_text += " Prepared text covers the complete converted range."
        coverage = {
            "unit": unit, "totalSourceUnits": total, "convertedSourceUnits": successful,
            "missingSourceUnits": missing, "pageLimit": max_pages, "conversionStatus": result.status.value,
            "rangeTruncated": page_truncated, "textTruncated": text_truncated,
            "previewSourceUnits": successful[:2] if pdf is not None else [],
            "description": coverage_text,
            "errors": [str(error.error_message)[:2000] for error in result.errors[:20]],
        }
        (output / "document.md").write_text(coverage_text + "\n\n" + markdown, encoding="utf-8")
        with (output / "document.json").open("w", encoding="utf-8") as handle:
            json.dump({"coverage": coverage, "document": document.export_to_dict()}, handle, ensure_ascii=False)
        prepared = {"text": coverage_text + "\n\n" + markdown[:TEXT_CHARACTERS], "images": images,
                    "truncated": page_truncated or text_truncated or partial}
        if images:
            prepared["previewFile"] = images[0]["fileName"]
        return prepared
    finally:
        if pdf is not None:
            pdf.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    parser.add_argument("--runtime-directory", required=True, type=Path)
    parser.add_argument("--max-pages", type=int, default=50, choices=range(1, 51))
    parser.add_argument("--format", choices=[".pdf", ".docx", ".pptx", ".xlsx"])
    args = parser.parse_args()
    runtime = args.runtime_directory.resolve()
    install_offline_policy(runtime)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            prepared = convert(args.input.resolve(), args.output_directory.resolve(), runtime,
                               args.max_pages, args.format or args.input.suffix.lower())
        print(json.dumps(prepared, ensure_ascii=False))
    except Exception as error:
        message = str(error)
        if any(word in message.lower() for word in ("model", "artifact", "huggingface", "offline", "download", "checkpoint")):
            message += " " + models_help(runtime)
        print(f"Attachment document preparation failed: {message[:6000]}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
