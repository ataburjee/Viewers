import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { DicomMetadataStore, MODULE_TYPES, useSystem } from '@ohif/core';

import Dropzone from 'react-dropzone';
import filesToStudies from './filesToStudies';
import { cacheDicomFiles, getCachedDicomFiles } from './dicomFileCache';

import { extensionManager } from '../../App';

import { Button, Icons } from '@ohif/ui-next';

const getLoadButton = (onDrop, text, isDir) => {
  return (
    <Dropzone
      onDrop={onDrop}
      noDrag
    >
      {({ getRootProps, getInputProps }) => (
        <div {...getRootProps()}>
          <Button
            variant="default"
            className="w-28"
            disabled={false}
            onClick={() => {}}
          >
            {text}
            {isDir ? (
              <input
                {...getInputProps()}
                webkitdirectory="true"
                mozdirectory="true"
                style={{ display: 'none' }}
              />
            ) : (
              <input
                {...getInputProps()}
                style={{ display: 'none' }}
              />
            )}
          </Button>
        </div>
      )}
    </Dropzone>
  );
};

type LocalProps = {
  modePath: string;
};

function Local({ modePath }: LocalProps) {
  const { servicesManager } = useSystem();
  const { customizationService } = servicesManager.services;
  const navigate = useNavigate();
  const dropzoneRef = useRef();
  const [dropInitiated, setDropInitiated] = React.useState(false);
  const [receivingFromApp, setReceivingFromApp] = React.useState(false);
  const receivingFromAppRef = useRef(false);
  const [statusMessage, setStatusMessage] = React.useState('');
  const openedByExternalApp = typeof window !== 'undefined' && !!window.opener;
  const ohifReadySent = useRef(false);
  const pendingFiles = useRef<File[]>([]);

  const LoadingIndicatorProgress = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  );

  // Initializing the dicom local dataSource
  const dataSourceModules = extensionManager.modules[MODULE_TYPES.DATA_SOURCE];
  const localDataSources = dataSourceModules.reduce((acc, curr) => {
    const mods = [];
    curr.module.forEach(mod => {
      if (mod.type === 'localApi') {
        mods.push(mod);
      }
    });
    return acc.concat(mods);
  }, []);

  const firstLocalDataSource = localDataSources[0];
  const dataSource = firstLocalDataSource.createDataSource({});

  const microscopyExtensionLoaded = extensionManager.registeredExtensionIds.includes(
    '@ohif/extension-dicom-microscopy'
  );

  const onDrop = async acceptedFiles => {
    const studies = await filesToStudies(acceptedFiles);

    const query = new URLSearchParams();

    if (microscopyExtensionLoaded) {
      // TODO: for microscopy, we are forcing microscopy mode, which is not ideal.
      //     we should make the local drag and drop navigate to the worklist and
      //     there user can select microscopy mode
      const smStudies = studies.filter(id => {
        const study = DicomMetadataStore.getStudy(id);
        return (
          study.series.findIndex(s => s.Modality === 'SM' || s.instances[0].Modality === 'SM') >= 0
        );
      });

      if (smStudies.length > 0) {
        smStudies.forEach(id => query.append('StudyInstanceUIDs', id));

        modePath = 'microscopy';
      }
    }

    // Todo: navigate to work list and let user select a mode
    studies.forEach(id => query.append('StudyInstanceUIDs', id));
    const basePath = modePath ? `/${modePath}` : '/studies';
    if (modePath) {
      query.append('datasources', 'dicomlocal');
      navigate(`${basePath}?${decodeURIComponent(query.toString())}`);
    } else {
      navigate(`${basePath}?${decodeURIComponent(query.toString())}`, {
        state: { datasources: 'dicomlocal' },
      });
    }
  };

  // Handle postMessage integration with external app (chavi):
  // 1. Respond to 'chavi-ping' with 'ohif-ready' so the other app knows OHIF is loaded.
  // 2. Receive 'chavi-dicom-files' with File[] and load them into the viewer.
  const ALLOWED_ORIGINS = ['https://chavi.ai', 'http://localhost:5173'];

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (!ALLOWED_ORIGINS.includes(event.origin)) return;

      if (event.data?.type === 'chavi-ping') {
        sessionStorage.setItem('chavi-session', '1');
        if (!ohifReadySent.current) {
          ohifReadySent.current = true;
          try {
            (event.source as Window).postMessage({ type: 'ohif-ready' }, event.origin || '*');
          } catch (_) {}
        }
        return;
      }

      // Receive DICOM files from the other app (supports batched sending)
      if (event.data?.type === 'chavi-dicom-files') {
        const { buffers, names, files: rawFiles, done } = event.data;
        let batch: File[] = [];
        if (buffers?.length) {
          batch = (buffers as ArrayBuffer[]).map(
            (buf, i) =>
              new File([buf], names?.[i] || `dicom_${i}.dcm`, { type: 'application/dicom' })
          );
        } else if (rawFiles?.length) {
          batch = rawFiles;
        }

        if (batch.length > 0) {
          pendingFiles.current.push(...batch);
          receivingFromAppRef.current = true;
          setReceivingFromApp(true);
          setStatusMessage(`Receiving… ${pendingFiles.current.length} file(s) so far`);
        }

        // Process when: explicit done:true OR not batching (done is undefined = single send)
        if (done === true || (done === undefined && pendingFiles.current.length > 0)) {
          const allFiles = [...pendingFiles.current];
          pendingFiles.current = [];

          setStatusMessage(`Loading ${allFiles.length} DICOM file(s)…`);

          try {
            await filesToStudies(allFiles);
            await cacheDicomFiles(allFiles).catch(console.error);
            receivingFromAppRef.current = false;
            setReceivingFromApp(false);
            sessionStorage.setItem('chavi-files-loaded', '1');
            navigate('/studies', { state: { datasources: 'dicomlocal' } });
          } catch (error) {
            console.error('Error loading DICOM files from external app:', error);
            receivingFromAppRef.current = false;
            setReceivingFromApp(false);
            setStatusMessage('Error loading DICOM files. Please try again.');
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [modePath, navigate]);

  // When Local mounts, clear the guard flags and try to restore cached DICOM files
  // from IndexedDB (e.g. after a page refresh that redirected back here via index.js).
  // We delay the restore by 1.5s to give the external app time to send a chavi-ping.
  // If a ping arrives first (ohifReadySent becomes true), we skip the cache restore
  // because the external app will send fresh files.
  useEffect(() => {
    sessionStorage.removeItem('chavi-files-loaded');
    sessionStorage.removeItem('chavi-guard-done');

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || ohifReadySent.current) return;
      getCachedDicomFiles()
        .then(async cachedFiles => {
          if (cancelled || ohifReadySent.current || cachedFiles.length === 0) return;
          setReceivingFromApp(true);
          setStatusMessage(`Restoring ${cachedFiles.length} cached DICOM file(s)…`);
          try {
            await filesToStudies(cachedFiles);
            if (cancelled || ohifReadySent.current) return;
            sessionStorage.setItem('chavi-files-loaded', '1');
            navigate('/studies', { state: { datasources: 'dicomlocal' } });
          } catch (err) {
            console.error('Error restoring cached DICOM files:', err);
            if (!cancelled) {
              setReceivingFromApp(false);
              setStatusMessage('');
            }
          }
        })
        .catch(console.error);
    }, 1500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Set body style
  useEffect(() => {
    document.body.classList.add('bg-background');
    return () => {
      document.body.classList.remove('bg-background');
    };
  }, []);

  return (
    <Dropzone
      ref={dropzoneRef}
      onDrop={acceptedFiles => {
        setDropInitiated(true);
        onDrop(acceptedFiles);
      }}
      noClick
    >
      {({ getRootProps }) => (
        <div
          {...getRootProps()}
          style={{ width: '100%', height: '100%' }}
        >
          <div className="flex h-screen w-screen items-center justify-center">
            <div className="bg-muted border-primary/60 mx-auto space-y-2 rounded-xl border border-dashed py-12 px-12 drop-shadow-md">
              <div className="flex items-center justify-center">
                <Icons.OHIFLogoColorDarkBackground className="h-18" />
              </div>
              <div className="space-y-2 py-6 text-center">
                {receivingFromApp ? (
                  <div className="flex flex-col items-center justify-center space-y-4 pt-12">
                    <LoadingIndicatorProgress className={'bg-background h-full w-full'} />
                    <p className="text-primary text-base">{statusMessage}</p>
                  </div>
                ) : dropInitiated ? (
                  <div className="flex flex-col items-center justify-center pt-12">
                    <LoadingIndicatorProgress className={'bg-background h-full w-full'} />
                  </div>
                ) : openedByExternalApp ? (
                  <div className="flex flex-col items-center justify-center space-y-4 pt-12">
                    <LoadingIndicatorProgress className={'bg-background h-full w-full'} />
                    <p className="text-primary text-base">Waiting for DICOM files…</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-primary pt-0 text-xl">
                      Drag and drop your DICOM files & folders here <br />
                      to load them locally.
                    </p>
                    <p className="text-muted-foreground text-base">
                      Note: Your data remains locally within your browser
                      <br /> and is never uploaded to any server.
                    </p>
                  </div>
                )}
              </div>
              {!openedByExternalApp && !receivingFromApp && !dropInitiated && (
                <div className="flex justify-center gap-2 pt-4">
                  {getLoadButton(onDrop, 'Load files', false)}
                  {getLoadButton(onDrop, 'Load folders', true)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Dropzone>
  );
}

export default Local;
