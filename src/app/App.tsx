import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Copy,
  Dices,
  ImagePlus,
  Images,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { API_ROUTES, PUBLIC_RANDOM_PATH } from "../apiContract";
import {
  DeleteBatchError,
  UploadBatchError,
  deleteImage,
  deleteImages,
  fetchAuthSession,
  fetchImages,
  fetchRandomImage,
  isAuthenticationError,
  login,
  logout,
  uploadImages,
} from "./api";
import type { GalleryImage } from "./types";
import { ACCEPTED_IMAGE_TYPES } from "../uploadLimits";

type Status = "idle" | "loading" | "uploading" | "randomizing" | "deleting";
type AuthStatus = "checking" | "idle" | "signing-in" | "signing-out";

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const mutationLockRef = useRef(false);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [randomImage, setRandomImage] = useState<GalleryImage | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("Loading image pool...");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [password, setPassword] = useState("");
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);

  const selectedImageIdSet = useMemo(() => new Set(selectedImageIds), [selectedImageIds]);
  const selectedCount = selectedImageIds.length;
  const allImagesSelected = images.length > 0 && selectedCount === images.length;
  const randomUrl = randomImage ? new URL(randomImage.url, window.location.origin).toString() : "";
  const redirectUrl = new URL(PUBLIC_RANDOM_PATH, window.location.origin).toString();

  useEffect(() => {
    let mounted = true;

    fetchImages()
      .then((items) => {
        if (!mounted) {
          return;
        }

        setImages(items);
        setRandomImage(items[0] ?? null);
        setMessage(items.length ? `${items.length} image${items.length === 1 ? "" : "s"} ready.` : "Upload images to seed the random API.");
      })
      .catch((err: Error) => {
        if (mounted) {
          setError(err.message);
          setMessage("The gallery could not be loaded.");
        }
      })
      .finally(() => {
        if (mounted) {
          setStatus("idle");
        }
      });

    fetchAuthSession()
      .then((sessionAuthenticated) => {
        if (mounted) {
          setAuthenticated(sessionAuthenticated);
        }
      })
      .catch((err: Error) => {
        if (mounted) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (mounted) {
          setAuthStatus("idle");
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const imageIds = new Set(images.map((image) => image.id));

    setSelectedImageIds((current) => {
      const next = current.filter((id) => imageIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [images]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allImagesSelected;
    }
  }, [allImagesSelected, selectedCount]);

  async function handleUpload(files: File[]) {
    if (busy || mutationLockRef.current) {
      setError("Wait for the current operation to finish.");
      return;
    }

    if (!authenticated) {
      setError("Sign in to upload images.");
      return;
    }

    const imageFiles = validateFiles(files);

    if (!imageFiles.length) {
      return;
    }

    mutationLockRef.current = true;

    setError("");
    setCopied(false);
    setStatus("uploading");
    setMessage(`Uploading ${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}...`);

    try {
      const uploaded = await uploadImages(imageFiles, (progress) => {
        setMessage(
          `Uploading ${progress.fileName} (${progress.fileIndex + 1}/${progress.fileCount}): ${formatBytes(progress.uploadedBytes)} of ${formatBytes(progress.totalBytes)}...`,
        );
      });

      setImages((current) => mergeImagesByNewest(current, uploaded));
      setRandomImage(uploaded[0] ?? null);
      setMessage(`${uploaded.length} upload${uploaded.length === 1 ? "" : "s"} added to the random pool.`);
    } catch (err) {
      if (isAuthenticationError(err)) {
        setAuthenticated(false);
      }

      if (err instanceof UploadBatchError) {
        setImages((current) => mergeImagesByNewest(current, err.uploaded));
        setRandomImage(err.uploaded[0] ?? null);
      }

      setError(err instanceof Error ? err.message : "Upload failed.");
      setMessage(err instanceof UploadBatchError ? "Upload stopped after a partial success." : "Upload failed.");
    } finally {
      mutationLockRef.current = false;
      setStatus("idle");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function pickRandom() {
    setError("");
    setCopied(false);
    setStatus("randomizing");
    setMessage("Selecting from the image pool...");

    try {
      const image = await fetchRandomImage();
      setRandomImage(image);
      setMessage(`Random API selected ${image.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No random image is available.");
      setMessage("The random API needs at least one upload.");
    } finally {
      setStatus("idle");
    }
  }

  async function refreshImages() {
    if (busy || mutationLockRef.current) {
      return;
    }

    mutationLockRef.current = true;
    setError("");
    setStatus("loading");
    setMessage("Refreshing gallery...");

    try {
      const nextImages = await fetchImages("no-cache");

      setImages(nextImages);
      setRandomImage((current) => {
        if (!current) {
          return nextImages[0] ?? null;
        }

        return nextImages.find((image) => image.id === current.id) ?? nextImages[0] ?? null;
      });
      setMessage(nextImages.length ? `${nextImages.length} image${nextImages.length === 1 ? "" : "s"} ready.` : "Upload images to seed the random API.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The gallery could not be refreshed.");
      setMessage("The gallery could not be refreshed.");
    } finally {
      mutationLockRef.current = false;
      setStatus("idle");
    }
  }

  function toggleImageSelection(id: string) {
    setSelectedImageIds((current) => (current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id]));
  }

  function toggleAllImages(checked: boolean) {
    setSelectedImageIds(checked ? images.map((image) => image.id) : []);
  }

  async function removeSelectedImages() {
    if (busy || mutationLockRef.current) {
      setError("Wait for the current operation to finish.");
      return;
    }

    if (!authenticated) {
      setError("Sign in to remove images.");
      return;
    }

    const visibleIds = new Set(images.map((image) => image.id));
    const idsToDelete = selectedImageIds.filter((id) => visibleIds.has(id));

    if (!idsToDelete.length) {
      setSelectedImageIds([]);
      return;
    }

    mutationLockRef.current = true;

    setStatus("deleting");
    setError("");
    setMessage(`Deleting ${idsToDelete.length} selected image${idsToDelete.length === 1 ? "" : "s"}...`);

    try {
      const deletedIds = await deleteImages(idsToDelete);
      applyDeletedImages(deletedIds);

      setMessage(`${deletedIds.length} selected image${deletedIds.length === 1 ? "" : "s"} removed from the random pool.`);
    } catch (err) {
      if (isAuthenticationError(err)) {
        setAuthenticated(false);
      }

      if (err instanceof DeleteBatchError) {
        applyDeletedImages(err.deleted);
        setMessage("Delete stopped after a partial success.");
      }

      await reconcileGalleryAfterFailure();

      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      mutationLockRef.current = false;
      setStatus("idle");
    }
  }

  function applyDeletedImages(deletedIds: string[]) {
    if (deletedIds.length === 0) {
      return;
    }

    const deletedIdSet = new Set(deletedIds);
    const nextImages = images.filter((image) => !deletedIdSet.has(image.id));

    setImages(nextImages);
    setSelectedImageIds((current) => current.filter((id) => !deletedIdSet.has(id)));
    setRandomImage((current) => (current && deletedIdSet.has(current.id) ? nextImages[0] ?? null : current));
  }

  async function reconcileGalleryAfterFailure() {
    try {
      const nextImages = await fetchImages("no-cache");

      setImages(nextImages);
      setRandomImage((current) =>
        current ? nextImages.find((image) => image.id === current.id) ?? nextImages[0] ?? null : nextImages[0] ?? null,
      );
    } catch {
      // Keep the original mutation error; the user can retry the explicit refresh later.
    }
  }

  async function removeImage(id: string) {
    if (busy || mutationLockRef.current) {
      setError("Wait for the current operation to finish.");
      return;
    }

    if (!authenticated) {
      setError("Sign in to remove images.");
      return;
    }

    mutationLockRef.current = true;

    setStatus("deleting");
    setError("");

    try {
      await deleteImage(id);
      const nextImages = images.filter((image) => image.id !== id);
      setImages(nextImages);
      setSelectedImageIds((current) => current.filter((selectedId) => selectedId !== id));
      setRandomImage((current) => (current?.id === id ? nextImages[0] ?? null : current));
      setMessage("Image removed from the random pool.");
    } catch (err) {
      if (isAuthenticationError(err)) {
        setAuthenticated(false);
      }

      await reconcileGalleryAfterFailure();
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      mutationLockRef.current = false;
      setStatus("idle");
    }
  }

  async function copyRandomEndpoint() {
    await navigator.clipboard.writeText(redirectUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function signIn() {
    if (busy || mutationLockRef.current) {
      return;
    }

    if (!password) {
      setError("Enter the upload password.");
      return;
    }

    mutationLockRef.current = true;

    setError("");
    setAuthStatus("signing-in");

    try {
      const nextAuthenticated = await login(password);
      setAuthenticated(nextAuthenticated);
      setPassword("");
      setMessage("Upload session active.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      mutationLockRef.current = false;
      setAuthStatus("idle");
    }
  }

  async function signOut() {
    if (busy || mutationLockRef.current) {
      return;
    }

    mutationLockRef.current = true;

    setError("");
    setAuthStatus("signing-out");

    try {
      await logout();
      setAuthenticated(false);
      setMessage("Upload session closed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign out failed.");
    } finally {
      mutationLockRef.current = false;
      setAuthStatus("idle");
    }
  }

  function validateFiles(files: File[]) {
    for (const file of files) {
      if (!isAcceptedImageType(file.type)) {
        setError(`${file.name} is not a supported image type.`);
        return [];
      }
    }

    return files;
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleUpload(Array.from(event.target.files ?? []));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);

    if (!busy) {
      handleUpload(Array.from(event.dataTransfer.files));
    }
  }

  const busy = status !== "idle" || authStatus !== "idle";
  const authBusy = busy;

  return (
    <main className="shell">
      <header className="site-masthead">
        <div className="masthead-inner">
          <div className="brand-lockup" aria-label="Neuro Gallery">
            <span className="brand-emblem" aria-hidden="true">
              <Images size={25} strokeWidth={1.8} />
            </span>
            <span className="brand-name" aria-hidden="true">
              <span>Neuro</span>
              <span>Gallery</span>
            </span>
          </div>

          <nav className="masthead-tools" aria-label="Gallery tools">
            <button
              className="tool-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !authenticated}
              title="Upload images"
              aria-label="Upload images"
              data-tooltip="Upload images"
            >
              <ImagePlus size={19} />
            </button>
            <button
              className="tool-button"
              type="button"
              onClick={pickRandom}
              disabled={busy || images.length === 0}
              title="Pick random image"
              aria-label="Pick random image"
              data-tooltip="Pick random"
            >
              <Dices size={19} />
            </button>
            <button
              className="tool-button"
              type="button"
              onClick={refreshImages}
              disabled={busy}
              title="Refresh gallery"
              aria-label="Refresh gallery"
              data-tooltip="Refresh gallery"
            >
              <RefreshCw className={status === "loading" ? "spin" : ""} size={18} />
            </button>
          </nav>
        </div>
      </header>

      <section className="workspace" aria-label="Neuro Gallery image API">
        <section className="notebook-sheet random-sheet">
          <span className="paper-tape tape-cyan" aria-hidden="true" />

          <header className="sheet-heading">
            <div>
              <p className="eyebrow">
                <Sparkles size={15} />
                Random image API
              </p>
              <h1>Random transmission</h1>
            </div>
            <span className={`pool-sticker ${images.length ? "ready" : ""}`}>
              {images.length ? `${images.length} image${images.length === 1 ? "" : "s"} ready` : "Waiting for uploads"}
            </span>
          </header>

          <div className={`preview-frame ${randomImage ? "has-image" : ""}`}>
            <span className="on-air-sticker" aria-hidden="true">On air</span>
            {randomImage ? (
              <img src={randomImage.url} alt={randomImage.name} decoding="async" fetchPriority="high" />
            ) : (
              <div className="empty-preview">
                <UploadCloud size={42} strokeWidth={1.8} />
                <strong>No images yet</strong>
                <span>Sign in and add the first upload</span>
              </div>
            )}
          </div>

          <div className="transmission-panel">
            <div className="transmission-copy">
              <div>
                <p className="label">Current random output</p>
                <h2>{randomImage ? randomImage.name : "Waiting for uploads"}</h2>
              </div>
              <p className={`status-copy ${error ? "error" : ""}`} aria-live="polite" aria-atomic="true">
                {error || message}
              </p>
            </div>

            <div className="endpoint-actions">
              <div className="endpoint-card" aria-label="Public random endpoint">
                <span>{PUBLIC_RANDOM_PATH}</span>
                <button type="button" onClick={copyRandomEndpoint} title="Copy endpoint" aria-label="Copy random endpoint">
                  <Copy size={17} />
                </button>
              </div>

              <div className="button-row">
                <button className="primary-button" type="button" onClick={pickRandom} disabled={busy || images.length === 0}>
                  {status === "randomizing" ? <Loader2 className="spin" size={18} /> : <Dices size={18} />}
                  Pick random
                </button>
                <a className={`secondary-button ${randomImage ? "" : "disabled"}`} href={randomUrl || undefined} target="_blank" rel="noreferrer">
                  <ArrowUpRight size={18} />
                  Open
                </a>
              </div>

              <p className="hint">{copied ? "Endpoint copied." : `${API_ROUTES.random}?format=json`}</p>
            </div>
          </div>
        </section>

        <aside className="notebook-sheet gallery-panel">
          <span className="paper-tape tape-pink" aria-hidden="true" />

          <header className="gallery-title">
            <div>
              <p className="eyebrow">Private controls</p>
              <h2>Upload library</h2>
            </div>
            <small>{status === "loading" ? "Loading" : selectedCount ? `${selectedCount} selected` : `${images.length} total`}</small>
          </header>

          <form
            className={`auth-panel ${authenticated ? "authenticated" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) {
                return;
              }

              if (authenticated) {
                signOut();
              } else {
                signIn();
              }
            }}
          >
            <div className="auth-copy">
              <span className="auth-icon">{authenticated ? <ShieldCheck size={20} /> : <KeyRound size={20} />}</span>
              <div>
                <strong>{authenticated ? "Uploader signed in" : "Uploader sign in"}</strong>
                <span>{authenticated ? "Upload and delete are unlocked" : "Password required for changes"}</span>
              </div>
            </div>

            {authenticated ? (
              <button className="auth-button" type="submit" disabled={authBusy}>
                {authStatus === "signing-out" ? <Loader2 className="spin" size={17} /> : <LogOut size={17} />}
                Sign out
              </button>
            ) : (
              <div className="auth-fields">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Upload password"
                  aria-label="Upload password"
                  autoComplete="current-password"
                  disabled={authBusy}
                />
                <button className="auth-button" type="submit" disabled={authBusy}>
                  {authStatus === "signing-in" ? <Loader2 className="spin" size={17} /> : <LogIn size={17} />}
                  Sign in
                </button>
              </div>
            )}
          </form>

          <div
            className={`drop-zone ${dragging ? "dragging" : ""} ${authenticated ? "" : "locked"}`}
            onDragEnter={(event) => {
              event.preventDefault();
              if (authenticated && !busy) {
                setDragging(true);
              }
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragging(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (authenticated && !busy) {
                fileInputRef.current?.click();
              } else if (!authenticated) {
                setError("Sign in to upload images.");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                if (authenticated && !busy) {
                  fileInputRef.current?.click();
                }
              }
            }}
          >
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              multiple
              disabled={!authenticated || busy}
              onChange={onInputChange}
            />
            <UploadCloud size={24} />
            <div>
              <strong>{authenticated ? (status === "uploading" ? "Uploading..." : "Drop images here") : "Upload locked"}</strong>
              <span>{authenticated ? "PNG, JPEG, WebP, AVIF or GIF" : "Sign in to add files"}</span>
            </div>
          </div>

          <div className="gallery-header">
            <span>Latest uploads</span>
            <button className="mini-refresh" type="button" onClick={refreshImages} disabled={busy} title="Refresh uploads" aria-label="Refresh uploads">
              <RefreshCw className={status === "loading" ? "spin" : ""} size={15} />
            </button>
          </div>

          <div className="selection-toolbar">
            <label className="selection-control select-all-control">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allImagesSelected}
                onChange={(event) => toggleAllImages(event.target.checked)}
                disabled={!images.length || busy}
              />
              <span className="selection-box" aria-hidden="true" />
              <span className="selection-text">
                <strong>Select all</strong>
                <small>{images.length ? `${images.length} available` : "No uploads"}</small>
              </span>
            </label>
            <button
              className="bulk-delete-button"
              type="button"
              onClick={removeSelectedImages}
              disabled={!authenticated || busy || selectedCount === 0}
              title={authenticated ? "Delete selected images" : "Sign in to delete"}
            >
              {status === "deleting" ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
              Delete selected
            </button>
          </div>

          <div className="image-list" aria-live="polite">
            {images.length ? (
              images.map((image) => (
                <article className="image-row" key={image.id}>
                  <label className="selection-control row-select">
                    <input
                      type="checkbox"
                      checked={selectedImageIdSet.has(image.id)}
                      onChange={() => toggleImageSelection(image.id)}
                      disabled={busy}
                      aria-label={`Select ${image.name}`}
                    />
                    <span className="selection-box" aria-hidden="true" />
                  </label>
                  <button
                    className="thumb-button"
                    type="button"
                    onClick={() => setRandomImage(image)}
                    title={`Preview ${image.name}`}
                    aria-label={`Preview ${image.name}`}
                  >
                    <img src={image.url} alt="" loading="lazy" decoding="async" />
                  </button>
                  <div className="row-copy">
                    <strong>{image.name}</strong>
                    <span>{formatBytes(image.size)} · {formatDate(image.uploadedAt)}</span>
                  </div>
                  <button
                    className="delete-button"
                    type="button"
                    onClick={() => removeImage(image.id)}
                    disabled={busy || !authenticated}
                    title={authenticated ? "Delete image" : "Sign in to delete"}
                    aria-label={`Delete ${image.name}`}
                  >
                    <Trash2 size={17} />
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-list">
                <ImagePlus size={28} />
                <strong>Your library is empty</strong>
                <span>Uploaded images will appear here.</span>
              </div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function isAcceptedImageType(type: string) {
  return ACCEPTED_IMAGE_TYPES.includes(type as (typeof ACCEPTED_IMAGE_TYPES)[number]);
}

function mergeImagesByNewest(current: GalleryImage[], uploaded: GalleryImage[]) {
  const imagesById = new Map(current.map((image) => [image.id, image]));

  for (const image of uploaded) {
    imagesById.set(image.id, image);
  }

  return Array.from(imagesById.values()).sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift() ?? "KB";

  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift() ?? unit;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
