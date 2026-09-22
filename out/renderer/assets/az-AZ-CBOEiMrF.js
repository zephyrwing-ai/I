const labels = { "paste": "Yapışdır", "pasteAsPlaintext": "Düz mətn kimi yapışdırın", "pasteCharts": "Diaqramları yapışdırın", "selectAll": "Hamısını seç", "multiSelect": "Seçimə element əlavə edin", "moveCanvas": "Kanvası köçürün", "cut": "Kəs", "copy": "Kopyala", "copyAsPng": "PNG olaraq panoya kopyala", "copyAsSvg": "SVG olaraq panoya kopyala", "copyText": "Mətn olaraq panoya kopyala", "copySource": "", "convertToCode": "", "bringForward": "Önə daşı", "sendToBack": "Geriyə göndərin", "bringToFront": "Önə gətirin", "sendBackward": "Geriyə göndərin", "delete": "Sil", "copyStyles": "Stilləri kopyalayın", "pasteStyles": "Stilləri yapışdırın", "stroke": "Strok rəngi", "background": "Arxa fon", "fill": "Doldur", "strokeWidth": "Strok eni", "strokeStyle": "Strok stili", "strokeStyle_solid": "Solid", "strokeStyle_dashed": "Kəsik", "strokeStyle_dotted": "Nöqtəli", "sloppiness": "Səliqəsizlik", "opacity": "Şəffaflıq", "textAlign": "Mətni uyğunlaşdır", "edges": "Kənarlar", "sharp": "Kəskin", "round": "Dəyirmi", "arrowheads": "Ox ucları", "arrowhead_none": "Heç biri", "arrowhead_arrow": "Ox", "arrowhead_bar": "Çubuq", "arrowhead_circle": "", "arrowhead_circle_outline": "", "arrowhead_triangle": "Üçbucaq", "arrowhead_triangle_outline": "", "arrowhead_diamond": "", "arrowhead_diamond_outline": "", "fontSize": "Şrift ölçüsü", "fontFamily": "Şrift qrupu", "addWatermark": '"Made with Excalidraw" əlavə et', "handDrawn": "Əllə çəkilmiş", "normal": "Normal", "code": "Kod", "small": "Kiçik", "medium": "Orta", "large": "Böyük", "veryLarge": "Çox böyük", "solid": "Solid", "hachure": "Ştrix", "zigzag": "Ziqzaq", "crossHatch": "Çarpaz dəlik", "thin": "İncə", "bold": "Qalın", "left": "Sol", "center": "Mərkəz", "right": "Sağ", "extraBold": "Ekstra qalın", "architect": "Memar", "artist": "Rəssam", "cartoonist": "Karikaturaçı", "fileTitle": "Fayl adı", "colorPicker": "Rəng seçən", "canvasColors": "Kanvas üzərində istifadə olunur", "canvasBackground": "Kanvas arxa fonu", "drawingCanvas": "Kanvas çəkmək", "layers": "Qatlar", "actions": "Hərəkətlər", "language": "Dil", "liveCollaboration": "Canlı əməkdaşlıq...", "duplicateSelection": "Dublikat", "untitled": "Başlıqsız", "name": "Ad", "yourName": "Adınız", "madeWithExcalidraw": "Excalidraw ilə hazırlanmışdır", "group": "Qrup şəklində seçim", "ungroup": "Qrupsuz seçim", "collaborators": "", "showGrid": "", "addToLibrary": "", "removeFromLibrary": "", "libraryLoadingMessage": "", "libraries": "", "loadingScene": "", "align": "", "alignTop": "", "alignBottom": "", "alignLeft": "", "alignRight": "", "centerVertically": "", "centerHorizontally": "", "distributeHorizontally": "", "distributeVertically": "", "flipHorizontal": "", "flipVertical": "", "viewMode": "", "share": "", "showStroke": "", "showBackground": "", "toggleTheme": "", "personalLib": "", "excalidrawLib": "", "decreaseFontSize": "", "increaseFontSize": "", "unbindText": "", "bindText": "", "createContainerFromText": "", "link": { "edit": "", "editEmbed": "", "create": "", "createEmbed": "", "label": "", "labelEmbed": "", "empty": "" }, "lineEditor": { "edit": "", "exit": "" }, "elementLock": { "lock": "", "unlock": "", "lockAll": "", "unlockAll": "" }, "statusPublished": "", "sidebarLock": "", "selectAllElementsInFrame": "", "removeAllElementsFromFrame": "", "eyeDropper": "", "textToDiagram": "", "prompt": "" };
const library = { "noItems": "", "hint_emptyLibrary": "", "hint_emptyPrivateLibrary": "" };
const buttons = { "clearReset": "", "exportJSON": "", "exportImage": "", "export": "", "copyToClipboard": "", "save": "", "saveAs": "", "load": "", "getShareableLink": "", "close": "", "selectLanguage": "", "scrollBackToContent": "", "zoomIn": "", "zoomOut": "", "resetZoom": "", "menu": "", "done": "", "edit": "", "undo": "", "redo": "", "resetLibrary": "", "createNewRoom": "", "fullScreen": "", "darkMode": "", "lightMode": "", "zenMode": "", "objectsSnapMode": "", "exitZenMode": "", "cancel": "", "clear": "", "remove": "", "embed": "", "publishLibrary": "", "submit": "", "confirm": "", "embeddableInteractionButton": "" };
const alerts = { "clearReset": "", "couldNotCreateShareableLink": "", "couldNotCreateShareableLinkTooBig": "", "couldNotLoadInvalidFile": "", "importBackendFailed": "", "cannotExportEmptyCanvas": "", "couldNotCopyToClipboard": "", "decryptFailed": "", "uploadedSecurly": "", "loadSceneOverridePrompt": "", "collabStopOverridePrompt": "", "errorAddingToLibrary": "", "errorRemovingFromLibrary": "", "confirmAddLibrary": "", "imageDoesNotContainScene": "", "cannotRestoreFromImage": "", "invalidSceneUrl": "", "resetLibrary": "", "removeItemsFromsLibrary": "", "invalidEncryptionKey": "", "collabOfflineWarning": "" };
const errors = { "unsupportedFileType": "", "imageInsertError": "", "fileTooBig": "", "svgImageInsertError": "", "failedToFetchImage": "", "invalidSVGString": "", "cannotResolveCollabServer": "", "importLibraryError": "", "collabSaveFailed": "", "collabSaveFailed_sizeExceeded": "", "imageToolNotSupported": "", "brave_measure_text_error": { "line1": "", "line2": "", "line3": "", "line4": "" }, "libraryElementTypeError": { "embeddable": "", "iframe": "", "image": "" }, "asyncPasteFailedOnRead": "", "asyncPasteFailedOnParse": "", "copyToSystemClipboardFailed": "" };
const toolBar = { "selection": "", "image": "", "rectangle": "", "diamond": "", "ellipse": "", "arrow": "", "line": "", "freedraw": "", "text": "", "library": "", "lock": "", "penMode": "", "link": "", "eraser": "", "frame": "", "magicframe": "", "embeddable": "", "laser": "", "hand": "", "extraTools": "", "mermaidToExcalidraw": "", "magicSettings": "" };
const headings = { "canvasActions": "", "selectedShapeActions": "", "shapes": "" };
const hints = { "canvasPanning": "", "linearElement": "", "freeDraw": "", "text": "", "embeddable": "", "text_selected": "", "text_editing": "", "linearElementMulti": "", "lockAngle": "", "resize": "", "resizeImage": "", "rotate": "", "lineEditor_info": "", "lineEditor_pointSelected": "", "lineEditor_nothingSelected": "", "placeImage": "", "publishLibrary": "", "bindTextToElement": "", "deepBoxSelect": "", "eraserRevert": "", "firefox_clipboard_write": "", "disableSnapping": "" };
const canvasError = { "cannotShowPreview": "", "canvasTooBig": "", "canvasTooBigTip": "" };
const errorSplash = { "headingMain": "", "clearCanvasMessage": "", "clearCanvasCaveat": "", "trackedToSentry": "", "openIssueMessage": "", "sceneContent": "" };
const roomDialog = { "desc_intro": "", "desc_privacy": "", "button_startSession": "", "button_stopSession": "", "desc_inProgressIntro": "", "desc_shareLink": "", "desc_exitSession": "", "shareTitle": "" };
const errorDialog = { "title": "" };
const exportDialog = { "disk_title": "", "disk_details": "", "disk_button": "", "link_title": "", "link_details": "", "link_button": "", "excalidrawplus_description": "", "excalidrawplus_button": "", "excalidrawplus_exportError": "" };
const helpDialog = { "blog": "", "click": "", "deepSelect": "", "deepBoxSelect": "", "curvedArrow": "", "curvedLine": "", "documentation": "", "doubleClick": "", "drag": "", "editor": "", "editLineArrowPoints": "", "editText": "", "github": "", "howto": "", "or": "", "preventBinding": "", "tools": "", "shortcuts": "", "textFinish": "", "textNewLine": "", "title": "", "view": "", "zoomToFit": "", "zoomToSelection": "", "toggleElementLock": "", "movePageUpDown": "", "movePageLeftRight": "" };
const clearCanvasDialog = { "title": "" };
const publishDialog = { "title": "", "itemName": "", "authorName": "", "githubUsername": "", "twitterUsername": "", "libraryName": "", "libraryDesc": "", "website": "", "placeholder": { "authorName": "", "libraryName": "", "libraryDesc": "", "githubHandle": "", "twitterHandle": "", "website": "" }, "errors": { "required": "", "website": "" }, "noteDescription": "", "noteGuidelines": "", "noteLicense": "", "noteItems": "", "atleastOneLibItem": "", "republishWarning": "" };
const publishSuccessDialog = { "title": "", "content": "" };
const confirmDialog = { "resetLibrary": "", "removeItemsFromLib": "" };
const imageExportDialog = { "header": "", "label": { "withBackground": "", "onlySelected": "", "darkMode": "", "embedScene": "", "scale": "", "padding": "" }, "tooltip": { "embedScene": "" }, "title": { "exportToPng": "", "exportToSvg": "", "copyPngToClipboard": "" }, "button": { "exportToPng": "", "exportToSvg": "", "copyPngToClipboard": "" } };
const encrypted = { "tooltip": "", "link": "" };
const stats = { "angle": "", "element": "", "elements": "", "height": "", "scene": "", "selected": "", "storage": "", "title": "", "total": "", "version": "", "versionCopy": "", "versionNotAvailable": "", "width": "" };
const toast = { "addedToLibrary": "", "copyStyles": "", "copyToClipboard": "", "copyToClipboardAsPng": "", "fileSaved": "", "fileSavedToFilename": "", "canvas": "", "selection": "", "pasteAsSingleElement": "", "unableToEmbed": "", "unrecognizedLinkFormat": "" };
const colors = { "transparent": "", "black": "", "white": "", "red": "", "pink": "", "grape": "", "violet": "", "gray": "", "blue": "", "cyan": "", "teal": "", "green": "", "yellow": "", "orange": "", "bronze": "" };
const welcomeScreen = { "app": { "center_heading": "", "center_heading_plus": "", "menuHint": "" }, "defaults": { "menuHint": "", "center_heading": "", "toolbarHint": "", "helpHint": "" } };
const colorPicker = { "mostUsedCustomColors": "", "colors": "", "shades": "", "hexCode": "", "noShades": "" };
const overwriteConfirm = { "action": { "exportToImage": { "title": "", "button": "", "description": "" }, "saveToDisk": { "title": "", "button": "", "description": "" }, "excalidrawPlus": { "title": "", "button": "", "description": "" } }, "modal": { "loadFromFile": { "title": "", "button": "", "description": "" }, "shareableLink": { "title": "", "button": "", "description": "" } } };
const mermaid = { "title": "", "button": "", "description": "", "syntax": "", "preview": "" };
const azAZ = {
  labels,
  library,
  buttons,
  alerts,
  errors,
  toolBar,
  headings,
  hints,
  canvasError,
  errorSplash,
  roomDialog,
  errorDialog,
  exportDialog,
  helpDialog,
  clearCanvasDialog,
  publishDialog,
  publishSuccessDialog,
  confirmDialog,
  imageExportDialog,
  encrypted,
  stats,
  toast,
  colors,
  welcomeScreen,
  colorPicker,
  overwriteConfirm,
  mermaid
};
export {
  alerts,
  buttons,
  canvasError,
  clearCanvasDialog,
  colorPicker,
  colors,
  confirmDialog,
  azAZ as default,
  encrypted,
  errorDialog,
  errorSplash,
  errors,
  exportDialog,
  headings,
  helpDialog,
  hints,
  imageExportDialog,
  labels,
  library,
  mermaid,
  overwriteConfirm,
  publishDialog,
  publishSuccessDialog,
  roomDialog,
  stats,
  toast,
  toolBar,
  welcomeScreen
};
