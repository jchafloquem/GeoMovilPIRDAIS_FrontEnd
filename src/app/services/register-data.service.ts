import { Injectable, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { ConnectionStatus, Network } from '@capacitor/network';
import { ToastController, NavController, AlertController, LoadingController } from '@ionic/angular/standalone';
import { BehaviorSubject } from 'rxjs';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import * as L from 'leaflet';

import { ApiService, MidagriProductor, ReniecResponse } from './api.service';

// Reutilizamos la interfaz de propiedades
export interface ValidationResult {
  isValid: boolean;
  missing: string[];
}

/**
 * Define la estructura de un objeto GeoJSON Feature para mejorar la seguridad de tipos.
 */
export interface GeoJSONFeature {
  type: 'Feature';
  properties: Partial<GeoJsonProperties>;
  geometry: {
    type: string;
    coordinates: any;
  };
}
// Reutilizamos la interfaz de propiedades
interface GeoJsonProperties {
  // Mapeo a la estructura de la base de datos
  INTERNAL_KEY?: string;
  FECHA_CREACION_REGISTRO?: string;
  FECHA_ACTUALIZACION_REGISTRO?: string;
  DNI: string;
  NOMBRES: string;
  APELLIDO_PATERNO: string;
  APELLIDO_MATERNO: string;
  NOMBRE_COMPLETO: string;
  FECHA_NACIMIENTO: string;
  CELULAR_PARTICIPANTE: string;
  TIPO_PRODUCTOR: string;
  TIPO_CULTIVO: string;
  OBSERVACIONES: string;
  CODIGO_AUTOGENERADO_MIDAGRI: string;
  FECHA_REGISTRO_MIDAGRI: string;
  ACTIVIDAD_AGRARIA: string;
  SUPERFICIE_MIDAGRI: string | null;
  REGIMEN_TENENCIA: string;
  SEXO: string;
  TXT_DEPARTAMENTO: string;
  TXT_PROVINCIA: string;
  TXT_DISTRITO: string;
  UBIGEO_OFICINA_ZONAL: string;
  UBIGEO_DEPARTAMENTO: string;
  UBIGEO_PROVINCIA: string;
  UBIGEO_DISTRITO: string;
  UBIGEO_CASERIO: string;
  PROFESIONAL_DNI: string;
  PROFESIONAL_NOMBRES: string;
  PROFESIONAL_APELLIDO_PATERNO: string;
  PROFESIONAL_APELLIDO_MATERNO: string;
  PROFESIONAL_CELULAR: string;
  PROFESIONAL_EMAIL: string;
  FUENTE: string;
  DATUM: string;
  DEVICE_UUID: string;
  RUTA_FOTOS: string[];
  RUTA_DNI_FRONT: string;
  RUTA_DNI_BACK: string;
  // Campos de estado de la app
  status?: 'draft' | 'pending';
  syncStatus?: 'pending';
  // Campos calculados de geometría que también se persisten
  perimetro?: string;
  area?: string;
  altitud?: string;
  centroide?: string;
  geometryTypeLabel?: string;
}

/**
 * Define la estructura de los datos que se mostrarán en la lista de registros.
 */
export interface SavedRecordSummary {
  key: string;
  name: string;
  type: string;
  icon: string;
  createdAt: string;
  thumbnail?: string;
  statusColor: 'danger' | 'warning' | 'success'; // Rojo, Ambar, Verde
}

const USER_PROFILE_KEY = 'userProfile';

@Injectable({
  providedIn: 'root'
})
export class RegisterDataService {

  private isOnline = true;

  // --- Estado Reactivo con BehaviorSubjects ---
  private readonly _geojson = new BehaviorSubject<GeoJSONFeature | null>(null);
  readonly geojson$ = this._geojson.asObservable();

  private readonly _editKey = new BehaviorSubject<string | null>(null);
  readonly editKey$ = this._editKey.asObservable();

  private readonly _photosForDisplay = new BehaviorSubject<string[]>([]);
  readonly photosForDisplay$ = this._photosForDisplay.asObservable();

  private readonly _savedPhotoUris = new BehaviorSubject<string[]>([]);

  private readonly _formData = new BehaviorSubject<Partial<GeoJsonProperties>>({
    DNI: '',
    NOMBRES: '',
    APELLIDO_PATERNO: '',
    APELLIDO_MATERNO: '',
    FECHA_NACIMIENTO: '',
    CELULAR_PARTICIPANTE: '',
    CODIGO_AUTOGENERADO_MIDAGRI: '',
    FECHA_REGISTRO_MIDAGRI: '',
    ACTIVIDAD_AGRARIA: '',
    SUPERFICIE_MIDAGRI: null,
    REGIMEN_TENENCIA: '',
    SEXO: '',
    TXT_DEPARTAMENTO: '',
    TXT_PROVINCIA: '',
    TXT_DISTRITO: '',
    TIPO_PRODUCTOR: '',
    TIPO_CULTIVO: '',
    UBIGEO_OFICINA_ZONAL: '',
    UBIGEO_DEPARTAMENTO: '',
    UBIGEO_PROVINCIA: '',
    UBIGEO_DISTRITO: '',
    UBIGEO_CASERIO: '',
    FUENTE: 'DEVIDA',
    DATUM: 'WGS-84',
    OBSERVACIONES: '',
    RUTA_DNI_FRONT: '',
    RUTA_DNI_BACK: '',
  });
  readonly formData$ = this._formData.asObservable();

  constructor(
    private router: Router,
    private toastController: ToastController,
    private navCtrl: NavController,
    private alertController: AlertController,
    private loadingController: LoadingController,
    private zone: NgZone,
    private apiService: ApiService
  ) {
    this.initializeNetworkListener();
  }

  // --- Métodos de Inicialización y Carga ---

  private async initializeNetworkListener() {
    // Espera a que la plataforma esté lista para evitar errores en el arranque
    await new Promise(resolve => setTimeout(resolve, 500));

    const status = await Network.getStatus();
    this.isOnline = status.connected;

    Network.addListener('networkStatusChange', (status: ConnectionStatus) => {
      // Solo actuar si el estado de la conexión realmente ha cambiado
      if (this.isOnline === status.connected) {
        return;
      }

      this.isOnline = status.connected;
      // Usamos NgZone para asegurar que los cambios se reflejen en la UI
      this.zone.run(async () => {
        if (this.isOnline) {
          await this.showToast('Conexión recuperada. Iniciando sincronización...', 'success', 'middle');
          this.syncPendingProductorData();
        } else {
          await this.showToast('Estás sin conexión. Se guardarán los datos localmente.', 'warning', 'middle');
        }
      });
    });
  }

  private async syncPendingProductorData() {
    const { keys } = await Preferences.keys();
    const recordKeys = keys.filter(k => k.startsWith('polygon_') || k.startsWith('point_') || k.startsWith('linestring_'));
    let syncedCount = 0;

    for (const key of recordKeys) {
      const { value } = await Preferences.get({ key });
      if (!value) continue;

      try {
        const geojson = JSON.parse(value);
        const properties = geojson.properties as GeoJsonProperties;

        // Condición: El registro está marcado como pendiente de sincronización.
        if (properties && (properties as any).syncStatus === 'pending') {
          // CORRECCIÓN: Usar el nuevo método centralizado y desestructurar la respuesta.
          const { data: fetchedData } = await this._fetchExternalProductorData(properties.DNI);

          // CORRECCIÓN: El nuevo método devuelve un objeto, por lo que verificamos si tiene contenido.
          if (fetchedData && Object.keys(fetchedData).length > 0) {
            // Fusionar los datos nuevos con los existentes y guardar
            Object.assign(properties, fetchedData);
            properties.NOMBRE_COMPLETO = `${properties.NOMBRES || ''} ${properties.APELLIDO_PATERNO || ''} ${properties.APELLIDO_MATERNO || ''}`.trim();
            properties.FECHA_ACTUALIZACION_REGISTRO = new Date().toISOString();
            delete (properties as any).syncStatus; // Elimina el flag de pendiente
            await Preferences.set({ key, value: JSON.stringify(geojson) });
            syncedCount++;

            // Si el usuario está viendo este registro, actualizamos la UI en tiempo real
            if (this._editKey.getValue() === key) {
              this.zone.run(() => this.loadFormDataFromProperties(properties));
            }
          }
        }
      } catch (error) {
        console.error(`[RegisterDataService] Error procesando registro pendiente ${key}:`, error);
      }
    }

    if (syncedCount > 0) {
      await this.showToast(`${syncedCount} registro(s) ha(n) sido sincronizado(s) con éxito.`, 'success', 'middle');
    }
  }

  public async loadInitialData(key: string | null, navigationState: any) {
    this.resetState();

    if (key) {
      // MODO EDICIÓN
      this._editKey.next(key);
      const { value } = await Preferences.get({ key });
      if (value) {
        const geojson = JSON.parse(value);
        this._geojson.next(geojson);
        this.calculateGeometryData();
        if (geojson?.properties) {
          this.loadFormDataFromProperties(geojson.properties);
          if (geojson.properties.RUTA_FOTOS && Array.isArray(geojson.properties.RUTA_FOTOS)) {
            this._savedPhotoUris.next(geojson.properties.RUTA_FOTOS);
            await this.loadPhotosForDisplay();
          }
        }
      } else {
        await this.showToast('Error: No se pudo cargar el polígono para editar.', 'danger', 'middle');
        this.navCtrl.navigateBack('/mapa');
      }
    } else if (navigationState && navigationState.geojson) {
      // MODO CREACIÓN
      const geojson = navigationState.geojson;
      this._geojson.next(geojson);
      this.calculateGeometryData();
    } else {
    }
  }

  private resetState() {
    this._geojson.next(null);
    this._editKey.next(null);
    this._photosForDisplay.next([]);
    this._savedPhotoUris.next([]);
    this._formData.next({
      // CORRECCIÓN: Usar la estructura de datos correcta de GeoJsonProperties
      DNI: '',
      NOMBRES: '',
      APELLIDO_PATERNO: '',
      APELLIDO_MATERNO: '',
      FECHA_NACIMIENTO: '',
      CELULAR_PARTICIPANTE: '',
      CODIGO_AUTOGENERADO_MIDAGRI: '',
      FECHA_REGISTRO_MIDAGRI: '',
      ACTIVIDAD_AGRARIA: '',
      SUPERFICIE_MIDAGRI: null,
      REGIMEN_TENENCIA: '',
      SEXO: '',
      TXT_DEPARTAMENTO: '',
      TXT_PROVINCIA: '',
      TXT_DISTRITO: '',
      TIPO_PRODUCTOR: '',
      TIPO_CULTIVO: '',
      UBIGEO_OFICINA_ZONAL: '',
      UBIGEO_DEPARTAMENTO: '',
      UBIGEO_PROVINCIA: '',
      UBIGEO_DISTRITO: '',
      UBIGEO_CASERIO: '',
      FUENTE: 'DEVIDA',
      DATUM: 'WGS-84',
      OBSERVACIONES: '',
      RUTA_DNI_FRONT: '',
      RUTA_DNI_BACK: '',
      // Resetear campos de geometría calculados
      perimetro: '', area: '', altitud: '', centroide: '',
      geometryTypeLabel: '',
    });
  }

  private loadFormDataFromProperties(properties: any) {
    // La carga es directa. Se priorizan los valores de geometría recién calculados
    // sobre los que pudieran estar guardados, que podrían estar obsoletos.
    const currentForm = this._formData.getValue();
    const newFormData = {
      ...properties,
      perimetro: currentForm.perimetro,
      area: currentForm.area,
      altitud: currentForm.altitud,
      centroide: currentForm.centroide,
      geometryTypeLabel: currentForm.geometryTypeLabel,
    };

    this._formData.next(newFormData);
  }

  // --- Lógica de Negocio (extraída de registerdata.page.ts) ---

  public async searchDni(isSync: boolean = false) {
    const currentFormData = this._formData.getValue();
    if (!currentFormData.DNI || currentFormData.DNI.length !== 8) {
      await this.showToast('Por favor, ingrese un DNI válido de 8 dígitos.', 'warning', 'top');
      return;
    }

    // --- NUEVA LÓGICA OFFLINE ---
    if (!this.isOnline) {
      await this.showToast('Sin conexión. Nombres y apellidos se completarán al recuperar internet.', 'tertiary', 'top');
      // Limpiamos los datos por si había una búsqueda anterior para forzar la sincronización
      currentFormData.NOMBRES = '';
      currentFormData.APELLIDO_PATERNO = '';
      currentFormData.APELLIDO_MATERNO = '';
      this._formData.next(currentFormData);
      return; // Salimos del método para no hacer la llamada a la API
    }
    // --- FIN LÓGICA OFFLINE ---

    const loading = !isSync ? await this.loadingController.create({ message: 'Buscando DNI...' }) : null;
    if (loading) await loading.present();

    try {
      const { data, message, color } = await this._fetchExternalProductorData(currentFormData.DNI!);

      // Actualiza el estado del formulario una sola vez con todos los datos consolidados
      this._formData.next({ ...currentFormData, ...data });

      // Solo mostramos el toast si NO es una sincronización automática
      if (!isSync) {
        await this.showToast(message, color, 'middle');
      }

    } finally {
      if (loading) await loading.dismiss();
    }
  }

  /**
   * Centraliza la lógica de búsqueda de datos de productor en RENIEC y MIDAGRI.
   * @param dni El DNI a consultar.
   * @returns Un objeto con los datos encontrados y la información para el toast.
   */
  private async _fetchExternalProductorData(dni: string): Promise<{ data: Partial<GeoJsonProperties>, message: string, color: 'success' | 'warning' | 'danger' }> {
    if (!this.isOnline || !dni || dni.length !== 8) {
      return { data: {}, message: 'Búsqueda no realizada (sin conexión o DNI inválido)', color: 'warning' };
    }

    const fetchedData: Partial<GeoJsonProperties> = {};
    let reniecSuccess = false;
    let midagriSuccess = false;

    try {
      const reniecData = await this.apiService.getReniecData(dni);
      if (reniecData) {
        fetchedData.NOMBRES = (reniecData.first_name || 'NO ENCONTRADO').toUpperCase();
        fetchedData.APELLIDO_PATERNO = (reniecData.first_last_name || 'NO ENCONTRADO').toUpperCase();
        fetchedData.APELLIDO_MATERNO = (reniecData.second_last_name || 'NO ENCONTRADO').toUpperCase();
        reniecSuccess = true;
      }
    } catch (err) {
    }

    try {
      const productor = await this.apiService.getMidagriData(dni);
      if (productor) {
        fetchedData.CODIGO_AUTOGENERADO_MIDAGRI = productor.txt_codigoautogenerado || '';
        if (productor.fec_registro) {
          const date = new Date(productor.fec_registro);
          // Usar formato ISO para consistencia
          fetchedData.FECHA_REGISTRO_MIDAGRI = !isNaN(date.getTime()) ? date.toISOString() : productor.fec_registro;
        }
        fetchedData.ACTIVIDAD_AGRARIA = productor.txt_actagraria || '';
        fetchedData.SUPERFICIE_MIDAGRI = productor.num_superficie || null;
        fetchedData.REGIMEN_TENENCIA = productor.txt_regtenencia || '';
        fetchedData.SEXO = productor.txt_sexo || '';
        fetchedData.TXT_DEPARTAMENTO = productor.txt_departamento || '';
        fetchedData.TXT_PROVINCIA = productor.txt_provincia || '';
        fetchedData.TXT_DISTRITO = productor.txt_distrito || '';
        midagriSuccess = true;
      }
    } catch (err) {
    }

    if (!reniecSuccess) {
      fetchedData.NOMBRES = 'NO ENCONTRADO';
      fetchedData.APELLIDO_PATERNO = 'NO ENCONTRADO';
      fetchedData.APELLIDO_MATERNO = 'NO ENCONTRADO';
    }
    if (!midagriSuccess) {
      // Asegurarse de que los campos queden vacíos o nulos si no se encuentran
      fetchedData.CODIGO_AUTOGENERADO_MIDAGRI = fetchedData.CODIGO_AUTOGENERADO_MIDAGRI ?? '';
      fetchedData.FECHA_REGISTRO_MIDAGRI = fetchedData.FECHA_REGISTRO_MIDAGRI ?? '';
      fetchedData.ACTIVIDAD_AGRARIA = fetchedData.ACTIVIDAD_AGRARIA ?? '';
      fetchedData.SUPERFICIE_MIDAGRI = fetchedData.SUPERFICIE_MIDAGRI ?? null;
      fetchedData.REGIMEN_TENENCIA = fetchedData.REGIMEN_TENENCIA ?? '';
      fetchedData.SEXO = fetchedData.SEXO ?? '';
      fetchedData.TXT_DEPARTAMENTO = fetchedData.TXT_DEPARTAMENTO ?? '';
      fetchedData.TXT_PROVINCIA = fetchedData.TXT_PROVINCIA ?? '';
      fetchedData.TXT_DISTRITO = fetchedData.TXT_DISTRITO ?? '';
    }

    let message = '', color: 'success' | 'warning' | 'danger' = 'danger';
    if (reniecSuccess && midagriSuccess) {
      message = 'Datos de RENIEC y MIDAGRI cargados.';
      color = 'success';
    } else if (reniecSuccess) {
      message = 'Datos de RENIEC cargados. No se encontraron en MIDAGRI.';
      color = 'warning';
    } else if (midagriSuccess) {
      message = 'Datos de MIDAGRI cargados. No se encontraron en RENIEC.';
      color = 'warning';
    } else {
      message = 'DNI no encontrado en ninguna de las fuentes.';
      color = 'danger';
    }

    return { data: fetchedData, message, color };
  }

  public async saveData() {
    const formData = this._formData.getValue();

    // --- Validación de Campos Obligatorios ---
    const missingFields = [];
    // Campos siempre obligatorios
    if (!formData.DNI) missingFields.push('DNI del productor');
    if (!formData.TIPO_PRODUCTOR) missingFields.push('Tipo de Productor');
    if (!formData.CELULAR_PARTICIPANTE) missingFields.push('Número de celular');
    if (!formData.RUTA_DNI_FRONT) missingFields.push('Foto frontal del DNI');
    if (!formData.RUTA_DNI_BACK) missingFields.push('Foto posterior del DNI');
    if (!formData.TIPO_CULTIVO) missingFields.push('Tipo de Cultivo');

    // Validación de fecha de nacimiento
    if (!formData.FECHA_NACIMIENTO) {
      missingFields.push('Fecha de nacimiento');
    } else if (!this.isOfLegalAge(formData.FECHA_NACIMIENTO)) {
      missingFields.push('El productor debe ser mayor de 18 años');
    }

    // Validación de fotos adicionales
    if (this._savedPhotoUris.getValue().length < 2) {
      missingFields.push('Se requieren al menos 2 fotos adicionales');
    }

    // Campos obligatorios solo si hay conexión a internet
    if (this.isOnline) {
      if (!formData.NOMBRES || formData.NOMBRES === 'PENDIENTE' || formData.NOMBRES === 'NO ENCONTRADO') {
        missingFields.push('Nombres del productor (búsqueda por DNI)');
      }
      // Añadimos la validación de los datos de ubicación que se autocompletan.
      // Si estos datos faltan, el usuario debe esperar a que terminen de cargar.
      if (!formData.UBIGEO_OFICINA_ZONAL) missingFields.push('Oficina Zonal (espere autocompletado)');
      if (!formData.UBIGEO_DEPARTAMENTO) missingFields.push('Departamento (espere autocompletado)');
      if (!formData.UBIGEO_PROVINCIA) missingFields.push('Provincia (espere autocompletado)');
      if (!formData.UBIGEO_DISTRITO) missingFields.push('Distrito (espere autocompletado)');
    }

    if (missingFields.length > 0) {
      // Mostramos un toast con el primer campo faltante para guiar al usuario.
      await this.showToast(`Falta completar: ${missingFields[0]}`, 'warning', 'top');
      return;
    }

    const geojson = this._geojson.getValue();
    if (!geojson) {
      return;
    }

    const isEditing = !!this._editKey.getValue();
    const geometryType = geojson.geometry.type.toLowerCase();
    let keyPrefix = 'polygon';
    if (geometryType.includes('point')) keyPrefix = 'point';
    else if (geometryType.includes('linestring')) keyPrefix = 'linestring';

    const key = isEditing ? this._editKey.getValue()! : `${keyPrefix}_${new Date().getTime()}`;
    const fullName = `${formData.NOMBRES || ''} ${formData.APELLIDO_PATERNO || ''} ${formData.APELLIDO_MATERNO || ''}`.trim();

    // Obtener datos del profesional y del dispositivo
    const deviceId = await Device.getId();
    const { value: profileValue } = await Preferences.get({ key: USER_PROFILE_KEY });
    const professionalProfile = profileValue ? JSON.parse(profileValue) : {};

    // Construimos las propiedades directamente desde el formData estandarizado
    const newProperties: Partial<GeoJsonProperties> = {
      ...formData,
      INTERNAL_KEY: key,
      NOMBRE_COMPLETO: fullName,
      OBSERVACIONES: (formData.OBSERVACIONES || '').toUpperCase(),
      PROFESIONAL_DNI: professionalProfile.dni || null,
      PROFESIONAL_NOMBRES: professionalProfile.nombres || null,
      PROFESIONAL_APELLIDO_PATERNO: professionalProfile.apellidoPaterno || null,
      PROFESIONAL_APELLIDO_MATERNO: professionalProfile.apellidoMaterno || null,
      PROFESIONAL_CELULAR: professionalProfile.celular || null,
      PROFESIONAL_EMAIL: professionalProfile.email || null,
      DEVICE_UUID: deviceId.identifier,
      RUTA_FOTOS: this._savedPhotoUris.getValue()
    };

    // Si estamos editando un borrador, eliminamos el estado 'draft' al guardar los datos completos.
    if (geojson.properties?.status === 'draft') {
      delete newProperties.status;
    }

    // Lógica de estado PENDIENTE mejorada
    const isDataIncompleteForSync = !newProperties.NOMBRES || newProperties.NOMBRES === 'PENDIENTE' || newProperties.NOMBRES === 'NO ENCONTRADO';
    if (!this.isOnline && isDataIncompleteForSync) {
      // Solo marcar como pendiente si estamos offline Y los datos de RENIEC/MIDAGRI faltan.
      newProperties.syncStatus = 'pending';
      newProperties.NOMBRE_COMPLETO = `PENDIENTE (DNI: ${formData.DNI || 'S/N'})`;
      // Forzamos los campos de nombres a un estado pendiente para la sincronización, ignorando la entrada manual.
      if (!newProperties.NOMBRES) newProperties.NOMBRES = 'PENDIENTE';
      if (!newProperties.APELLIDO_PATERNO) newProperties.APELLIDO_PATERNO = '';
      if (!newProperties.APELLIDO_MATERNO) newProperties.APELLIDO_MATERNO = '';
    } else {
      // Si guardamos con conexión, nos aseguramos de que el registro no esté marcado como pendiente.
      // Esto es crucial al editar un registro que estaba pendiente y ahora se completa online.
      delete (newProperties as any).syncStatus;
    }


    if (isEditing) {
      newProperties.FECHA_CREACION_REGISTRO = geojson.properties?.FECHA_CREACION_REGISTRO;
      newProperties.FECHA_ACTUALIZACION_REGISTRO = new Date().toISOString();
    } else {
      newProperties.FECHA_CREACION_REGISTRO = new Date().toISOString();
    }
    geojson.properties = newProperties;

    await Preferences.set({ key, value: JSON.stringify(geojson) });

    await this.showToast(
      isEditing ? 'Información actualizada con éxito' : 'Registro guardado con éxito',
      'success', 'middle'
    );
    this.navCtrl.navigateBack('/mapa');
  }

  /**
   * Orquesta el proceso completo de envío de registros completos al backend.
   * Esta función reemplaza la lógica que estaba en el componente mapa.page.
   */
  public async sendAllCompletedRecords(): Promise<{ successCount: number, errorCount: number, total: number }> {
    if (!this.isOnline) {
      await this.showToast("Necesita conexión a internet para enviar los datos a DEVIDA.", "warning", "middle");
      return { successCount: 0, errorCount: 0, total: 0 };
    }

    const allRecords = await this.getAllRawRecords();
    const recordsToSend = allRecords.filter(rec => this.isRecordComplete(rec.properties));

    if (recordsToSend.length === 0) {
      await this.showToast("No hay registros completos (verdes) para enviar.", "warning", "middle");
      return { successCount: 0, errorCount: 0, total: 0 };
    }

    let successCount = 0;
    let errorCount = 0;
    const loading = await this.loadingController.create({
      message: `Enviando 0 de ${recordsToSend.length} registros...`,
      spinner: "crescent"
    });
    await loading.present();

    for (let i = 0; i < recordsToSend.length; i++) {
      const record = recordsToSend[i];
      loading.message = `Enviando ${i + 1} de ${recordsToSend.length}...`;

      try {
        // 1. Preparar la geometría en formato WKT
        const wktGeometry = this.geometryToWkt(record.geometry);

        // 2. Construir un payload LIMPIO para la API, mapeando explícitamente solo los campos necesarios.
        // Esto previene que se envíen campos antiguos o temporales del frontend.
        const props = record.properties as GeoJsonProperties;

        // Limpieza de valores numéricos (quitar ' ha', ' m', ' msnm') para la base de datos
        const parseNumeric = (val: string | null | undefined) => {
          if (!val) return null;
          const clean = val.toString().replace(/[^0-9.]/g, '');
          return clean ? parseFloat(clean) : null;
        };

        // Preparar array de fotos para la tabla 'fotos_registro'
        const fotosPayload: { tipo_foto: string, ruta_foto: string }[] = [];
        // Función auxiliar para leer el archivo y obtener el Base64
        const procesarFoto = async (tipo: string, ruta: string) => {
          if (!ruta) return;
          try {
            // Filesystem.readFile devuelve los datos en Base64 por defecto si no se especifica encoding
            const file = await Filesystem.readFile({ path: ruta });
            // Aseguramos que enviamos el string de datos
            const base64Data = typeof file.data === 'string' ? file.data : JSON.stringify(file.data);
            fotosPayload.push({ tipo_foto: tipo, ruta_foto: base64Data });
          } catch (e) {
            console.warn(`No se pudo leer la foto ${ruta} para envío:`, e);
          }
        };

        if (props.RUTA_DNI_FRONT) await procesarFoto('DNI_FRONT', props.RUTA_DNI_FRONT);
        if (props.RUTA_DNI_BACK) await procesarFoto('DNI_BACK', props.RUTA_DNI_BACK);
        if (props.RUTA_FOTOS) {
          for (const f of props.RUTA_FOTOS) {
            await procesarFoto('PARCELA', f);
          }
        }

        const payload = {
          // --- Tabla: registros_productor ---
          internal_key: props.INTERNAL_KEY,
          dni_productor: props.DNI,
          nombre_completo: props.NOMBRE_COMPLETO,
          nombres: props.NOMBRES,
          apellido_paterno: props.APELLIDO_PATERNO,
          apellido_materno: props.APELLIDO_MATERNO,
          fecha_nacimiento: props.FECHA_NACIMIENTO,
          sexo: props.SEXO,
          celular_participante: props.CELULAR_PARTICIPANTE,
          actividad_agraria: props.ACTIVIDAD_AGRARIA,
          tipo_cultivo: props.TIPO_CULTIVO,
          superficie_midagri: props.SUPERFICIE_MIDAGRI, // Ya es numérico o null
          regimen_tenencia: props.REGIMEN_TENENCIA,
          tipo_productor: props.TIPO_PRODUCTOR,

          // Datos geográficos y de área
          geom: wktGeometry, // Se enviará como texto WKT (ej: "POLYGON((...))")
          centroide: props.centroide, // "Lat: ..., Lon: ..."
          area_ha: parseNumeric(props.area), // Convierte "1.50 ha" a 1.50
          perimetro_m: parseNumeric(props.perimetro), // Convierte "200 m" a 200.00

          // Ubicación administrativa
          txt_departamento: props.TXT_DEPARTAMENTO,
          txt_provincia: props.TXT_PROVINCIA,
          txt_distrito: props.TXT_DISTRITO,
          ubigeo_distrito: props.UBIGEO_DISTRITO,

          // Datos del profesional y auditoría
          profesional_dni: props.PROFESIONAL_DNI,
          profesional_nombres: props.PROFESIONAL_NOMBRES,
          profesional_apellidos: `${props.PROFESIONAL_APELLIDO_PATERNO || ''} ${props.PROFESIONAL_APELLIDO_MATERNO || ''}`.trim(),
          profesional_celular: props.PROFESIONAL_CELULAR,
          profesional_email: props.PROFESIONAL_EMAIL,
          device_uuid: props.DEVICE_UUID,

          // --- Para Tabla: fotos_registro ---
          // Enviamos un array para que el backend itere e inserte en la tabla secundaria
          fotos_asociadas: fotosPayload
        };

        // 3. Enviar el registro individual
        const response = await this.apiService.enviarRegistroIndividual(payload);

        if (response.status >= 200 && response.status < 300) {
          successCount++;
          // Opcional: Marcar el registro como enviado o eliminarlo de `Preferences`
          // Por ahora, lo dejamos para que el usuario pueda reenviarlo si es necesario.
        } else {
          errorCount++;
        }
      } catch (error) {
        errorCount++;
        // Loguear el error para depuración
        console.error(`Error al enviar el registro ${record.properties.INTERNAL_KEY}:`, error);
      }
    }

    await loading.dismiss();

    // Informar al usuario del resultado
    const message = `Envío finalizado. Éxitos: ${successCount}, Fallos: ${errorCount}.`;
    await this.showToast(message, errorCount > 0 ? 'warning' : 'success', 'middle', 4000);

    return { successCount, errorCount, total: recordsToSend.length };
  }

  /**
   * Valida si un registro tiene todos los campos obligatorios para ser enviado.
   * Esta es la fuente de verdad para la validación.
   * @param props Las propiedades del registro GeoJSON.
   */
  public isRecordComplete(props: Partial<GeoJsonProperties>): boolean {
    if (!props) return false;

    const isDraft = props.status === 'draft';
    const isPendingSync = props.syncStatus === 'pending';

    if (isDraft || isPendingSync) return false;

    return !!(
      props.DNI && props.TIPO_PRODUCTOR &&
      props.CELULAR_PARTICIPANTE && props.RUTA_DNI_FRONT &&
      props.RUTA_DNI_BACK && props.TIPO_CULTIVO &&
      props.FECHA_NACIMIENTO && this.isOfLegalAge(props.FECHA_NACIMIENTO) &&
      props.UBIGEO_OFICINA_ZONAL && props.UBIGEO_DEPARTAMENTO &&
      props.UBIGEO_PROVINCIA && props.UBIGEO_DISTRITO &&
      props.RUTA_FOTOS && props.RUTA_FOTOS.length >= 2 &&
      props.NOMBRES && props.NOMBRES !== 'PENDIENTE' && props.NOMBRES !== 'NO ENCONTRADO'
    );
  }

  /**
   * Convierte un objeto de geometría GeoJSON a su representación WKT (Well-Known Text).
   */
  private geometryToWkt(geometry: { type: string, coordinates: any }): string | null {
    if (!geometry || !geometry.coordinates) return null;

    // CORRECCIÓN: Asegurar que siempre haya 3 coordenadas (X Y Z) para cumplir con la columna GeometryZ de la BD.
    const coordToString = (coords: any[]) => {
      const x = coords[0];
      const y = coords[1];
      // Si no hay Z (altitud), asumimos 0 para que la base de datos lo acepte
      const z = coords.length > 2 ? coords[2] : 0;
      return `${x} ${y} ${z}`;
    };

    switch (geometry.type) {
      case 'Point':
        return `POINT Z (${coordToString(geometry.coordinates)})`;
      case 'LineString':
        return `LINESTRING Z (${geometry.coordinates.map(coordToString).join(', ')})`;
      case 'Polygon':
        if (!geometry.coordinates[0]) return null; // Protección contra polígonos vacíos

        // Asegurar que el polígono esté cerrado (primer y último punto iguales)
        const coords = [...geometry.coordinates[0]];
        if (coords.length > 0) {
          const first = coords[0];
          const last = coords[coords.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            coords.push(first);
          }
        }

        const ring = coords.map(coordToString).join(', ');
        return `POLYGON Z ((${ring}))`;
      default:
        return null;
    }
  }
  /**
   * Obtiene todos los registros guardados en su formato GeoJSON crudo.
   * @returns Una promesa que resuelve a un array de GeoJSON Features.
   */
  public async getAllRawRecords(): Promise<any[]> {
    const { keys } = await Preferences.keys();
    const recordKeys = keys.filter(k =>
      k.startsWith('polygon_') || k.startsWith('point_') || k.startsWith('linestring_')
    );

    const allRecords: any[] = [];
    for (const key of recordKeys) {
      const { value } = await Preferences.get({ key });
      if (value) {
        try {
          allRecords.push(JSON.parse(value));
        } catch (e) {
          console.error(`[RegisterDataService] Error al parsear registro ${key} de Preferences:`, e);
        }
      }
    }
    return allRecords;
  }

  /**
   * Obtiene todos los registros guardados y los devuelve ordenados por fecha de creación, del más nuevo al más antiguo.
   */
  public async getSortedSavedRecords(): Promise<SavedRecordSummary[]> {
    // 1. Obtener todas las claves de registros.
    const { keys } = await Preferences.keys();
    const recordKeys = keys.filter(k =>
      k.startsWith('polygon_') || k.startsWith('point_') || k.startsWith('linestring_')
    );

    // 2. Cargar todos los registros en un array intermedio para poder ordenarlos por sus propiedades.
    const allRecords: { key: string, geojson: any }[] = [];
    for (const key of recordKeys) {
      const { value } = await Preferences.get({ key });
      if (value) {
        try {
          const geojson = JSON.parse(value);
          allRecords.push({ key, geojson });
        } catch (e) {
          console.error(`[RegisterDataService] Error al parsear registro ${key} de Preferences:`, e);
        }
      }
    }

    // 3. Ordenar el array con la nueva lógica de prioridad.
    allRecords.sort((a, b) => {
      const propsA = a.geojson.properties || {};
      const propsB = b.geojson.properties || {};

      const isA_Incomplete = propsA.status === 'draft' || propsA.syncStatus === 'pending';
      const isB_Incomplete = propsB.status === 'draft' || propsB.syncStatus === 'pending';

      // Asignar un "score" de prioridad: 0 para incompletos, 1 para completos.
      const scoreA = isA_Incomplete ? 0 : 1;
      const scoreB = isB_Incomplete ? 0 : 1;

      // Primero, ordenar por estado (incompletos primero).
      if (scoreA !== scoreB) {
        return scoreA - scoreB;
      }

      // Si el estado es el mismo, ordenar por fecha (el más nuevo primero).
      const timeA = parseInt(a.key.split('_')[1] || '0', 10);
      const timeB = parseInt(b.key.split('_')[1] || '0', 10);
      return timeB - timeA;
    });

    // 4. Mapear los registros ya ordenados al formato final que necesita la vista.
    return allRecords.map(record => {
      const props = record.geojson.properties || {};
      const geometryType = record.geojson.geometry?.type || 'Unknown';
      const thumbnailUrl = (props.RUTA_FOTOS && props.RUTA_FOTOS.length > 0) ? Capacitor.convertFileSrc(props.RUTA_FOTOS[0]) : undefined;

      // --- Lógica para determinar el color del estado ---
      let statusColor: 'danger' | 'warning' | 'success' = 'success'; // Verde por defecto
      const isDraft = props.status === 'draft';
      const isPendingSync = props.syncStatus === 'pending';
      const isDataMissing = !this.isRecordComplete(props);

      if (isDraft) {
        statusColor = 'danger'; // Rojo
      } else if (isPendingSync || isDataMissing) {
        statusColor = 'warning'; // Ambar
      }
      // --- Fin de la lógica de estado ---

      return {
        key: record.key,
        name: props.NOMBRE_COMPLETO || 'Registro sin nombre',
        type: geometryType,
        icon: this.getIconForType(geometryType),
        createdAt: props.FECHA_CREACION_REGISTRO ? new Date(props.FECHA_CREACION_REGISTRO).toLocaleDateString('es-PE') : 'Fecha no disponible',
        thumbnail: thumbnailUrl,
        statusColor: statusColor
      };
    });
  }

  /**
   * Devuelve el nombre del ícono correspondiente al tipo de geometría.
   * @param type El tipo de geometría (e.g., 'Polygon', 'Point').
   */
  private getIconForType(type: string): string {
    return 'help-circle-outline';
  }

  /**
   * Elimina un registro guardado de Preferences.
   * @param key La clave del registro a eliminar.
   */
  public async deleteRecord(key: string): Promise<void> {
    // Por ahora, solo elimina de Preferences.
    // En el futuro, podría necesitar eliminar fotos asociadas del sistema de archivos.
    const { value } = await Preferences.get({ key });
    // Aquí iría la lógica para eliminar las fotos del filesystem si es necesario.
    await Preferences.remove({ key });
  }

  /**
   * Guarda una geometría como un borrador inmediatamente después de ser creada en el mapa
   * y navega a la página de registro para completar los datos.
   * @param geojson El objeto GeoJSON de la nueva geometría.
   */
  public async createDraftAndNavigate(geojson: any) {
    if (!geojson || !geojson.geometry || !geojson.geometry.type.toLowerCase().includes('point')) {
      await this.showToast('Error al crear la geometría. Solo se permite la creación de puntos.', 'danger');
      return;
    }

    // A partir de ahora, solo se generan puntos.
    const keyPrefix = 'point';
    const key = `${keyPrefix}_${new Date().getTime()}`;

    await Preferences.set({ key, value: JSON.stringify(geojson) });
    this.navCtrl.navigateForward(`/mapa/registerdata/${key}`);
  }

  /**
   * Valida que los campos offline obligatorios estén completos.
   */
  public isProductorTabValid(): ValidationResult {
    const data = this._formData.getValue();
    const missing: string[] = [];

    if (!data.DNI || data.DNI.length !== 8) missing.push('DNI (8 dígitos)');
    if (!data.TIPO_PRODUCTOR) missing.push('Tipo de productor');
    if (!data.CELULAR_PARTICIPANTE) missing.push('Número de celular');
    if (!data.RUTA_DNI_FRONT) missing.push('Foto frontal del DNI');
    if (!data.RUTA_DNI_BACK) missing.push('Foto posterior del DNI');

    // Validación de fecha de nacimiento
    if (!data.FECHA_NACIMIENTO) {
      missing.push('Fecha de nacimiento');
    } else if (!this.isOfLegalAge(data.FECHA_NACIMIENTO)) {
      missing.push('El productor debe ser mayor de 18 años');
    }

    return {
      isValid: missing.length === 0,
      missing: missing,
    };
  }

  /**
   * Verifica si hay registros guardados localmente que están pendientes de sincronización.
   * @returns `true` si hay al menos un registro pendiente, `false` en caso contrario.
   */
  public async hasPendingSyncRecords(): Promise<boolean> {
    const { keys } = await Preferences.keys();
    const recordKeys = keys.filter(k => k.startsWith('polygon_') || k.startsWith('point_') || k.startsWith('linestring_'));

    for (const key of recordKeys) {
      const { value } = await Preferences.get({ key });
      if (value) {
        try {
          const geojson = JSON.parse(value);
          if (geojson.properties && (geojson.properties as any).syncStatus === 'pending') {
            return true; // Se encontró al menos un registro pendiente
          }
        } catch (e) { /* Ignorar errores de parseo al solo verificar */ }
      }
    }
    return false; // No se encontraron registros pendientes
  }

  // --- Lógica de Fotos ---

  public async takePicture() {
    if (this._photosForDisplay.getValue().length >= 6) { // No hay errores aquí, pero es una buena práctica de validación.
      await this.showToast('Límite de 6 fotos alcanzado.', 'warning');
      return;
    }

    const permissions = await Camera.requestPermissions({ permissions: ['camera', 'photos'] });
    if (permissions.camera !== 'granted' || permissions.photos !== 'granted') { // No hay errores aquí, pero es una buena práctica de validación.
      await this.showToast('Se necesitan permisos de cámara y galería.', 'warning');
      return;
    }

    const loading = await this.loadingController.create({ message: 'Procesando foto...' });
    await loading.present();

    try {
      const currentFormData = this._formData.getValue();
      const productorDni = currentFormData.DNI;

      if (!productorDni || productorDni.length !== 8) {
        await this.showToast('Por favor, ingrese un DNI válido de 8 dígitos antes de tomar la foto.', 'warning', 'top');
        return;
      }

      const image = await Camera.getPhoto({
        quality: 90, allowEditing: false, resultType: CameraResultType.Base64, source: CameraSource.Camera
      });
      if (!image.base64String) return;

      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
      const coords = position.coords;
      if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
        throw new Error('Coordenadas inválidas o nulas recibidas del GPS.');
      }

      const date = new Date();
      const textLines = [
        `Lat: ${coords.latitude.toFixed(5)} Lon: ${coords.longitude.toFixed(5)}`,
        `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
      ];

      const imageWithOverlayBase64 = await this.addTextOverlayToImage(`data:image/jpeg;base64,${image.base64String}`, textLines);
      const photoNumber = this._savedPhotoUris.getValue().length + 1;
      const fileName = `${productorDni}_${photoNumber}.jpeg`;

      const savedFile = await Filesystem.writeFile({
        path: fileName, data: imageWithOverlayBase64, directory: Directory.Data
      });

      try {
        await Filesystem.writeFile({
          path: `GeoDAIS_dni/${fileName}`, data: imageWithOverlayBase64, directory: Directory.Documents, recursive: true
        }); // No hay errores aquí, pero es una buena práctica de validación.
        await this.showToast('Copia de la foto guardada en la galería.', 'success');
      } catch (publicSaveError: any) {
        console.warn(`[RegisterDataService] No se pudo guardar copia de la foto en la galería pública:`, publicSaveError);
      }

      const currentSavedUris = this._savedPhotoUris.getValue();
      this._savedPhotoUris.next([...currentSavedUris, savedFile.uri]);
      const currentDisplayPhotos = this._photosForDisplay.getValue();
      this._photosForDisplay.next([...currentDisplayPhotos, Capacitor.convertFileSrc(savedFile.uri)]);

    } catch (error: any) {
      const rawErrorMessage = error.message || JSON.stringify(error);

      let displayMessage = `Error: ${rawErrorMessage}`; // Mensaje por defecto
      if (rawErrorMessage.toLowerCase().includes('could not obtain location in time')) {
        displayMessage = 'No se pudo obtener la ubicación GPS a tiempo. Intente en un lugar con mejor señal.';
      }

      await this.showToast(displayMessage, 'danger', 'middle', 5000);
    } finally {
      await loading.dismiss();
    }
  }

  public async deletePhoto(index: number) {
    const alert = await this.alertController.create({
      header: 'Confirmar', message: '¿Estás seguro de que quieres eliminar esta foto?',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Eliminar',
          handler: async () => {
            const uris = this._savedPhotoUris.getValue();
            const displayPhotos = this._photosForDisplay.getValue();
            const uriToDelete = uris[index];
            try {
              await Filesystem.deleteFile({ path: uriToDelete });
            } catch (e) {
              console.warn(`[RegisterDataService] No se pudo eliminar el archivo de foto ${uriToDelete}:`, e);
            }
            uris.splice(index, 1);
            displayPhotos.splice(index, 1);
            this._savedPhotoUris.next(uris);
            this._photosForDisplay.next(displayPhotos);
          }
        }
      ]
    });
    await alert.present();
  }

  public async takeDniPicture(side: 'front' | 'back') {
    const permissions = await Camera.requestPermissions({ permissions: ['camera'] });
    if (permissions.camera !== 'granted') { // No hay errores aquí, pero es una buena práctica de validación.
      await this.showToast('Se necesita permiso de cámara.', 'warning');
      return;
    }

    const loading = await this.loadingController.create({ message: 'Procesando foto...' });
    await loading.present();

    try {
      const currentFormData = this._formData.getValue();
      const productorDni = currentFormData.DNI;
      const recordKey = this._editKey.getValue();

      if (!productorDni || productorDni.length !== 8) {
        await this.showToast('Por favor, ingrese un DNI válido de 8 dígitos antes de tomar la foto.', 'warning', 'top');
        return;
      }

      if (!recordKey) {
        await this.showToast('Error: No se pudo identificar el registro actual. Intente de nuevo.', 'danger', 'middle');
        return;
      }


      const image = await Camera.getPhoto({
        quality: 90,
        allowEditing: false,
        resultType: CameraResultType.Uri, // Usar URI es más eficiente
        source: CameraSource.Camera
      });

      if (!image.path) return;

      // Leemos el archivo de la ruta temporal que nos da la cámara
      const fileData = await Filesystem.readFile({
        path: image.path
      });

      const fileName = `dni_${side}_${productorDni}_${recordKey}.jpeg`;

      // Si ya existe una foto para este lado, la eliminamos primero
      const existingUri = side === 'front' ? currentFormData.RUTA_DNI_FRONT : currentFormData.RUTA_DNI_BACK;
      if (existingUri) {
        try {
          // El URI guardado ya es la ruta completa, no necesitamos especificar el directorio
          await Filesystem.deleteFile({ path: existingUri });
        } catch (e) {
          console.warn(`[RegisterDataService] No se pudo eliminar el archivo de foto de DNI ${existingUri}:`, e);
        }
      }

      // Escribimos el archivo en el directorio de datos de la app para obtener un URI permanente
      const savedFile = await Filesystem.writeFile({
        path: fileName,
        data: fileData.data, // Usamos los datos en base64 leídos del archivo temporal
        directory: Directory.Data
      });

      // Guardar una copia en la carpeta pública 'GeoDAIS'
      try {
        await Filesystem.writeFile({
          path: `GeoDAIS_Fotos/${fileName}`,
          data: fileData.data,
          directory: Directory.Documents,
          recursive: true
        });
        // No mostramos un toast aquí para no ser repetitivos con el de las otras fotos.
      } catch (publicSaveError: any) {
      }

      // Actualizamos el estado del formulario con el URI completo y correcto
      if (side === 'front') {
        currentFormData.RUTA_DNI_FRONT = savedFile.uri;
      } else {
        currentFormData.RUTA_DNI_BACK = savedFile.uri;
      }
      this._formData.next(currentFormData);

    } catch (error: any) {
      const errorMessage = error.message || JSON.stringify(error);
      if (errorMessage.toLowerCase().includes('user cancelled')) {
        return; // No mostrar error si el usuario cancela
      }
      await this.showToast(`Error: ${errorMessage}`, 'danger', 'middle', 5000);
    } finally {
      await loading.dismiss();
    }
  }

  public async deleteDniPicture(side: 'front' | 'back') {
    const currentFormData = this._formData.getValue();
    const uriToDelete = side === 'front' ? currentFormData.RUTA_DNI_FRONT : currentFormData.RUTA_DNI_BACK;

    if (uriToDelete) {
      try {
        // El URI guardado ya es la ruta completa, no necesitamos especificar el directorio
        await Filesystem.deleteFile({ path: uriToDelete });
      } catch (e) {
        console.warn(`[RegisterDataService] No se pudo eliminar el archivo de foto de DNI ${uriToDelete}:`, e);
      }

      if (side === 'front') {
        currentFormData.RUTA_DNI_FRONT = '';
      } else {
        currentFormData.RUTA_DNI_BACK = '';
      }
      this._formData.next(currentFormData);
    }
  }

  // --- Métodos Privados de Ayuda (Helper) ---

  private async loadPhotosForDisplay() {
    const displayPhotos: string[] = [];
    for (const fileUri of this._savedPhotoUris.getValue()) {
      displayPhotos.push(Capacitor.convertFileSrc(fileUri));
    }
    this._photosForDisplay.next(displayPhotos);
  }

  private calculateGeometryData() {
    const geojson = this._geojson.getValue();
    if (!geojson || !geojson.geometry || !geojson.geometry.coordinates) return;

    const geometryType = geojson.geometry.type;
    // MEJORA: Clonar el estado para evitar mutaciones directas y comportamientos inesperados.
    const data = { ...this._formData.getValue() };

    if (geometryType === 'Point') {
      data.geometryTypeLabel = 'Punto';
      const coords = geojson.geometry.coordinates;
      if (!coords || coords.length < 2) return;
      data.centroide = `Lat: ${coords[1].toFixed(5)}, Lon: ${coords[0].toFixed(5)}`;
      data.altitud = (coords[2] !== undefined) ? `${coords[2].toFixed(2)} msnm` : 'No disponible';
      data.area = 'N/A (Punto)';
      data.perimetro = 'N/A (Punto)';
    } else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
      data.geometryTypeLabel = 'Línea';
      const coords = geometryType === 'LineString' ? geojson.geometry.coordinates : geojson.geometry.coordinates[0];
      if (!coords || coords.length < 2) return;
      const latlngs: L.LatLng[] = coords.map((c: any) => L.latLng(c[1], c[0]));
      let length = 0;
      for (let i = 0; i < latlngs.length - 1; i++) {
        length += latlngs[i].distanceTo(latlngs[i + 1]);
      }
      data.perimetro = `${length.toFixed(2)} m`;
      data.area = 'N/A (Línea)';
      const center = L.polyline(latlngs).getBounds().getCenter();
      data.centroide = `Lat: ${center.lat.toFixed(5)}, Lon: ${center.lng.toFixed(5)}`;
      data.altitud = this.calculateAverageAltitude(coords);
    // MEJORA: Ser explícito con los tipos de geometría para evitar errores con tipos no manejados.
    } else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
      data.geometryTypeLabel = 'Polígono';

      // CORRECCIÓN: Acceder de forma segura a las coordenadas para evitar errores con MultiPolygon vacíos.
      let coords;
      if (geometryType === 'Polygon') {
        coords = geojson.geometry.coordinates[0];
      } else { // MultiPolygon
        if (geojson.geometry.coordinates && geojson.geometry.coordinates.length > 0) {
          coords = geojson.geometry.coordinates[0][0];
        }
      }

      if (!coords || coords.length < 3) return;
      const latlngs: L.LatLng[] = coords.map((c: any) => L.latLng(c[1], c[0]));

      // CORRECCIÓN: Asegurarse de que el polígono esté cerrado para el cálculo del área, evitando resultados incorrectos.
      const closedLatlngs = [...latlngs];
      if (closedLatlngs.length > 0 && closedLatlngs[0].distanceTo(closedLatlngs[closedLatlngs.length - 1]) > 1) {
        closedLatlngs.push(closedLatlngs[0]);
      }
      const areaM2 = L.GeometryUtil.geodesicArea(closedLatlngs);
      data.area = `${(areaM2 / 10000).toFixed(4)} ha`;

      let perimeter = 0;
      for (let i = 0; i < latlngs.length - 1; i++) {
        perimeter += latlngs[i].distanceTo(latlngs[i + 1]);
      }
      if (latlngs.length > 0 && latlngs[0].distanceTo(latlngs[latlngs.length - 1]) > 1) {
        perimeter += latlngs[latlngs.length - 1].distanceTo(latlngs[0]);
      }
      data.perimetro = `${perimeter.toFixed(2)} m`;

      const center = L.polygon(latlngs).getBounds().getCenter();
      data.centroide = `Lat: ${center.lat.toFixed(5)}, Lon: ${center.lng.toFixed(5)}`;
      data.altitud = this.calculateAverageAltitude(coords);
    }
    this._formData.next(data);
    // Iniciar autocompletado de ubigeo después de calcular los datos geométricos
    this.autocompletarUbicacion(geojson.geometry);
  }

  private calculateAverageAltitude(coords: any[]): string {
    const altitudes = coords.map((c: any[]) => c[2]).filter((alt: number | undefined) => alt !== undefined && typeof alt === 'number');
    if (altitudes.length > 0) {
      const sum = altitudes.reduce((a, b) => a + b, 0);
      return `${(sum / altitudes.length).toFixed(2)} msnm`;
    } else {
      return 'No disponible';
    }
  }

  private async autocompletarUbicacion(geometry: any) {
    if (!geometry) return;

    // Si ya existen datos de ubicación, no volvemos a buscarlos para evitar el toast.
    const existingData = this._formData.getValue();
    if (existingData.UBIGEO_DEPARTAMENTO || existingData.UBIGEO_PROVINCIA || existingData.UBIGEO_DISTRITO) {
      return;
    }

    let point: { x: number, y: number };

    // Determinar el punto a consultar (centroide para líneas y polígonos)
    if (geometry.type === 'Point') {
      point = { x: geometry.coordinates[0], y: geometry.coordinates[1] };
    } else {
      let latlngs: L.LatLng[];
      if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
        const coords = geometry.type === 'LineString' ? geometry.coordinates : geometry.coordinates[0];
        // CORRECCIÓN: Una línea necesita al menos 2 puntos para tener un centro.
        if (!coords || coords.length < 2) return;
        latlngs = coords.map((c: any) => L.latLng(c[1], c[0]));
        const center = L.polyline(latlngs).getBounds().getCenter();
        point = { x: center.lng, y: center.lat };
      } else if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
        // CORRECCIÓN: Acceder de forma segura a las coordenadas para evitar errores.
        let coords;
        if (geometry.type === 'Polygon') {
          coords = geometry.coordinates[0];
        } else { // MultiPolygon
          if (geometry.coordinates && geometry.coordinates.length > 0) {
            coords = geometry.coordinates[0][0];
          }
        }
        // CORRECCIÓN: Un polígono necesita al menos 3 puntos para tener un centro.
        if (!coords || coords.length < 3) return;
        latlngs = coords.map((c: any) => L.latLng(c[1], c[0]));
        const center = L.polygon(latlngs).getBounds().getCenter();
        point = { x: center.lng, y: center.lat };
      } else {
        return;
      }
    }

    // --- Query for Distrito/Provincia/Departamento ---
    const ubigeoQueryParams = new URLSearchParams({
      geometry: JSON.stringify({ x: point.x, y: point.y }),
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'nombdep,nombprov,nombdist',
      returnGeometry: 'false',
      f: 'json'
    });
    const ubigeoUrl = `https://services8.arcgis.com/tPY1NaqA2ETpJ86A/ArcGIS/rest/services/caribgeoportal/FeatureServer/6/query?${ubigeoQueryParams.toString()}`;

    // --- Query for Oficina Zonal ---
    const zonalQueryParams = new URLSearchParams({
      geometry: JSON.stringify({ x: point.x, y: point.y }),
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'nombre',
      returnGeometry: 'false',
      f: 'json'
    });
    const zonalUrl = `https://services8.arcgis.com/tPY1NaqA2ETpJ86A/ArcGIS/rest/services/caribgeoportal/FeatureServer/0/query?${zonalQueryParams.toString()}`;

    try {
      const [ubigeoResponse, zonalResponse] = await Promise.all([
        CapacitorHttp.get({ url: ubigeoUrl }),
        CapacitorHttp.get({ url: zonalUrl })
      ]);

      const currentFormData = this._formData.getValue();
      let ubigeoDataFound = false;

      // Process Ubigeo Response
      if (ubigeoResponse.status === 200 && ubigeoResponse.data && ubigeoResponse.data.features && ubigeoResponse.data.features.length > 0) {
        const attributes = ubigeoResponse.data.features[0].attributes;
        currentFormData.UBIGEO_DEPARTAMENTO = attributes.nombdep || '';
        currentFormData.UBIGEO_PROVINCIA = attributes.nombprov || '';
        currentFormData.UBIGEO_DISTRITO = attributes.nombdist || '';
        ubigeoDataFound = true;
      }

      // Process Zonal Office Response
      if (zonalResponse.status === 200 && zonalResponse.data && zonalResponse.data.features && zonalResponse.data.features.length > 0) {
        const attributes = zonalResponse.data.features[0].attributes;
        currentFormData.UBIGEO_OFICINA_ZONAL = attributes.nombre || 'FUERA DE LA OFICINA ZONAL';
      } else {
        currentFormData.UBIGEO_OFICINA_ZONAL = 'FUERA DE LA OFICINA ZONAL';
      }

      // Update state immutably
      const updatedFormData = { ...currentFormData };
      this.zone.run(() => this._formData.next(updatedFormData));

      if (ubigeoDataFound) {
        await this.showToast('Datos de ubicación autocompletados.', 'success');
      }

    } catch (error: any) {
      await this.showToast(`No se pudo autocompletar la ubicación: ${error.message || 'Error de red'}`, 'warning');
    }
  }

  private addTextOverlayToImage(base64ImageData: string, textLines: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          if (img.width === 0 || img.height === 0) return reject(new Error('La imagen se cargó pero sus dimensiones son 0.'));
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('No se pudo obtener el contexto 2D del canvas.'));

          const MAX_DIMENSION = 1920;
          let targetWidth = img.width, targetHeight = img.height;
          if (targetWidth > MAX_DIMENSION || targetHeight > MAX_DIMENSION) {
            if (targetWidth > targetHeight) {
              targetHeight = Math.round(targetHeight * (MAX_DIMENSION / targetWidth));
              targetWidth = MAX_DIMENSION;
            } else {
              targetWidth = Math.round(targetWidth * (MAX_DIMENSION / targetHeight));
              targetHeight = MAX_DIMENSION;
            }
          }
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

          const fontSize = Math.max(28, Math.floor(Math.min(targetWidth, targetHeight) / 35));
          const padding = fontSize * 0.7;
          const lineHeight = fontSize * 1.25;
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'left';

          const textWidth = Math.max(...textLines.map(line => ctx.measureText(line).width));
          const bgHeight = (lineHeight * textLines.length) + padding;
          const bgWidth = textWidth + (padding * 2);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
          ctx.fillRect(0, canvas.height - bgHeight, bgWidth, bgHeight);

          ctx.fillStyle = 'white';
          ctx.shadowColor = 'black';
          ctx.shadowBlur = 5;
          let y = canvas.height - padding;
          for (let i = textLines.length - 1; i >= 0; i--) {
            ctx.fillText(textLines[i], padding, y);
            y -= lineHeight;
          }
          resolve(canvas.toDataURL('image/jpeg', 0.9));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = (err) => reject(new Error(`Error al cargar la imagen: ${JSON.stringify(err)}`));
      img.src = base64ImageData;
    });
  }

  private isOfLegalAge(birthDateString: string): boolean {
    if (!birthDateString) return false;
    // La fecha de ion-datetime viene en formato ISO 8601 (ej: "2006-01-01T00:00:00")
    const birthDate = new Date(birthDateString);
    if (isNaN(birthDate.getTime())) {
      return false;
    }

    const today = new Date();

    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDifference = today.getMonth() - birthDate.getMonth();

    if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age >= 18;
  }

  /**
   * Muestra un toast (mensaje emergente) de forma centralizada.
   * @param message El mensaje a mostrar.
   * @param color El color del toast.
   * @param position La posición en la pantalla.
   * @param duration La duración en milisegundos.
   */
  public async showToast(
    message: string,
    color: 'success' | 'danger' | 'warning' | 'tertiary' | 'primary' | 'medium' = 'tertiary',
    position: 'top' | 'bottom' | 'middle' = 'middle',
    duration: number = 3000
  ) {
    const toast = await this.toastController.create({
      message,
      duration,
      position,
      color,
      cssClass: 'multiline-toast' // Clase para permitir múltiples líneas
    });
    await toast.present();
  }
}
